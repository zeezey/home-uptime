// One run of the monitor (index.ts calls it from the cron trigger). Everything it reaches out to comes in as
// `deps` and `env`, so test/run.test.ts can drive a whole run -- an outage included -- and count its subrequests.
//
// Unlike the GitHub runner, a Worker's fetch is not challenged by Bot Fight Mode (proved 2026-10-03: 200 with the
// real page on every target), so it checks the sites the way a visitor reaches them -- through Cloudflare -- and a
// dead house shows up as Cloudflare's 52x errors. `cache: "no-store"` keeps an edge copy from answering for a dead
// origin.
//
// THE SUBREQUEST BUDGET. The Free plan allows 50 subrequests a run, and an outage is when a run needs the most: every
// failing target is tried again. So every fetch goes through one counter (logic.ts Budget) that refuses the 51st,
// the alerts and the Healthchecks ping have their fetches kept back from the start (alertReserve), and the retries
// only spend what is left: a target past the budget is tried fewer times, and one the first round can't reach at
// all is "unknown", never "down". The alerts go out as soon as the checks are done, before anything else.
//
// State is one KV key, `state` (see logic.ts State), written once per run: 288 writes a day, under the free plan's
// 1,000. Putting any value under the KV key `test-alert` makes the next run send one test alert and delete it.
import {
	KV_OPS,
	SITES_TARGET,
	SITES_URL,
	SUBREQUEST_LIMIT,
	Budget,
	afterAlerts,
	alertReserve,
	attemptOk,
	decideAlerts,
	decideSites,
	parseSites,
	parseTargets,
	siteTargets,
	withSince,
	type Alert,
	type State,
	type Target,
	type TargetResult,
} from "./logic.ts";

/** The part of a KV namespace a run uses (a real KVNamespace fits; the tests pass a Map). */
export interface Kv {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

/** What a run reaches out with. index.ts passes the real ones; the tests pass fakes. */
export interface Deps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
}

export interface Env {
	STATE: Kv;
	/** The ntfy URL (same as the launcher's LAUNCHER_ALERT_WEBHOOK). */
	ALERT_WEBHOOK: string;
	/** Optional ntfy.sh account token: without one, ntfy.sh refuses Workers (see send()). */
	NTFY_TOKEN?: string;
	/** Discord webhook, used when ntfy refuses (the one Tower's Unraid notifications post to). */
	DISCORD_WEBHOOK?: string;
	/**
	 * The owner's email path (2026-10-03, "just email me if it goes down"): a Healthchecks.io check's ping URL
	 * (https://hc-ping.com/<uuid>). Every run pings it — plainly when everything is up, `/fail` with the down list when
	 * not — and Healthchecks emails on each change (down, back up), and also when the pings stop (this Worker dead).
	 */
	HC_URL?: string;
}

const UA = "home-uptime (cloudflare worker)";
export const ATTEMPTS = 3;
export const RETRY_MS = 20_000;
const TIMEOUT_MS = 20_000;
/**
 * A Worker may have six requests waiting for response headers at once; the runtime queues the rest, with their
 * timeouts already running. During a house outage the first six wait ~20 s for Cloudflare's 522, so anything
 * queued behind them -- the website on Vercel, say -- would time out without ever being asked. So the checks run
 * at most six at a time, and each timeout starts when its request does.
 */
export const CONNECTIONS = 6;

async function pool<T, R>(items: T[], size: number, f: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const lane = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await f(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
	return out;
}

/** A run's way out: every fetch is counted against the budget, and the one past it is never made. */
interface Io {
	net: (url: string, init: RequestInit) => Promise<Response>;
	log: (line: string) => void;
}

function io(budget: Budget, deps: Deps): Io {
	return {
		net: (url, init) =>
			budget.take() ? deps.fetch(url, init) : Promise.reject(new Error(`over the ${SUBREQUEST_LIMIT}-subrequest budget`)),
		log: deps.log,
	};
}

async function get(x: Io, url: string): Promise<{ status: number; body: string; why: string }> {
	try {
		const r = await x.net(url, {
			headers: { "user-agent": UA },
			redirect: "manual",
			cache: "no-store",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const body = await r.text();
		const why = [`status=${r.status}`, r.headers.get("cf-mitigated") && `cf-mitigated: ${r.headers.get("cf-mitigated")}`]
			.filter(Boolean)
			.join(" ");
		return { status: r.status, body, why };
	} catch (e) {
		return { status: 0, body: "", why: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
	}
}

/**
 * Down only after THREE failures 20 s apart: one dropped packet should not wake anyone up. The first round tries
 * every target (CONNECTIONS at a time); each later round tries again only the ones still failing, and only as many as the budget
 * has room for once `reserve` (the alerts' fetches) is kept back. A target the first round has no room for is
 * `unknown`; one a later round has no room for is judged on the tries it had, and says so.
 */
export async function checkAll(
	x: Io,
	targets: Target[],
	budget: Budget,
	reserve: number,
	sleep: (ms: number) => Promise<void>,
): Promise<Omit<TargetResult, "since">[]> {
	const out = new Map<string, Omit<TargetResult, "since">>();
	const tries = new Map<string, number>();
	const room = () => Math.max(0, budget.left() - reserve);
	let failing: Target[] = [];
	let batch = targets.slice(0, room());
	for (const t of targets.slice(batch.length)) {
		out.set(t.name, { name: t.name, url: t.url, up: false, unknown: true, why: `not checked: over the ${SUBREQUEST_LIMIT}-subrequest budget` });
	}
	for (let round = 1; batch.length; round++) {
		const got = await pool(batch, CONNECTIONS, (t) => get(x, t.url));
		failing = [];
		batch.forEach((t, i) => {
			const r = got[i];
			tries.set(t.name, (tries.get(t.name) ?? 0) + 1);
			if (attemptOk(r.status, r.body, t.want)) {
				out.set(t.name, { name: t.name, url: t.url, up: true, why: "" });
			} else {
				const why = r.status === 200 ? `status=200 but "${t.want}" is not on the page` : r.why;
				out.set(t.name, { name: t.name, url: t.url, up: false, why });
				failing.push(t);
			}
		});
		if (round >= ATTEMPTS || !failing.length || !room()) break;
		await sleep(RETRY_MS);
		batch = failing.slice(0, room());
	}
	for (const t of failing) {
		const n = tries.get(t.name) ?? 0;
		const r = out.get(t.name);
		if (r && n < ATTEMPTS) r.why += ` (${n} of ${ATTEMPTS} tries: the rest went over the subrequest budget)`;
	}
	return targets.map((t) => out.get(t.name) as Omit<TargetResult, "since">);
}

/** Which listings are live, from the listing server itself; null when it can't say (the house may be down). */
async function liveSites(x: Io, sleep: (ms: number) => Promise<void>): Promise<string[] | null> {
	for (let i = 1; i <= 2; i++) {
		const r = await get(x, SITES_URL);
		if (r.status === 200) {
			try {
				const sites = parseSites(JSON.parse(r.body));
				if (sites) return sites;
			} catch {
				/* not JSON: try again */
			}
		}
		if (i < 2) await sleep(RETRY_MS);
	}
	return null;
}

async function post(x: Io, channel: string, title: string, url: string, init: RequestInit): Promise<boolean> {
	try {
		const r = await x.net(url, { ...init, method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (r.ok) x.log(`alert "${title}" delivered via ${channel}`);
		else x.log(`alert "${title}" refused by ${channel}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
		return r.ok;
	} catch (e) {
		x.log(`alert "${title}" failed via ${channel}: ${e}`);
		return false;
	}
}

/**
 * ntfy first (the phone channel the GitHub workflow uses), Discord when ntfy refuses. Anonymous ntfy.sh publishes
 * from a Worker are refused: its daily quota is per IP and Workers share Cloudflare's IPs ("daily message quota
 * reached", 0 of 8 accepted on 2026-10-03). An ntfy.sh account token (secret NTFY_TOKEN) gives a per-user quota;
 * until one is set, alerts arrive through Discord (secret DISCORD_WEBHOOK, the channel Tower's own alerts use).
 */
async function send(x: Io, env: Env, a: { title: string; priority: string; tags: string; body: string }): Promise<boolean> {
	const headers: Record<string, string> = { Title: a.title, Priority: a.priority, Tags: a.tags };
	if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
	if (await post(x, "ntfy", a.title, env.ALERT_WEBHOOK, { headers, body: a.body })) return true;
	if (!env.DISCORD_WEBHOOK) return false;
	const icon = a.priority === "high" ? "🚨 " : a.tags === "white_check_mark" ? "✅ " : "";
	return post(x, "discord", a.title, env.DISCORD_WEBHOOK, {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content: `${icon}**${a.title}**\n${a.body}`.slice(0, 1900), allowed_mentions: { parse: [] } }),
	});
}

/** One Healthchecks ping per run (see Env.HC_URL); Healthchecks itself decides when to email. */
async function heartbeat(x: Io, env: Env, results: TargetResult[]): Promise<void> {
	if (!env.HC_URL?.startsWith("https://hc-ping.com/")) return;
	const down = results.filter((r) => !r.up && !r.unknown);
	const unknown = results.filter((r) => r.unknown);
	const url = env.HC_URL.replace(/\/+$/, "") + (down.length ? "/fail" : "");
	const skipped = unknown.length ? ` Not checked this run: ${unknown.map((r) => r.name).join(", ")}.` : "";
	const body = down.length
		? `Not answering: ${down.map((r) => `${r.name} (${r.url}) ${r.why}`).join("; ")}. If everything is down at once, the house (power/internet) or Tower is the likely cause.${skipped}`
		: `All ${results.length - unknown.length} checked are up.${skipped}`;
	try {
		const r = await x.net(url, { method: "POST", body: body.slice(0, 9000), signal: AbortSignal.timeout(TIMEOUT_MS) });
		x.log(`healthchecks ${down.length ? "fail" : "ok"} ping: HTTP ${r.status}`);
	} catch (e) {
		x.log(`healthchecks ping failed: ${e}`);
	}
}

export async function readState(kv: Kv): Promise<State | null> {
	try {
		const raw = await kv.get("state");
		return raw === null ? null : (JSON.parse(raw) as State);
	} catch {
		return null;
	}
}

export async function run(env: Env, targetsTxt: string, deps: Deps): Promise<State> {
	const started = Date.now();
	// KV calls are kept out of the fetch budget up front (see logic.ts KV_OPS).
	const budget = new Budget(SUBREQUEST_LIMIT - KV_OPS);
	const x = io(budget, deps);
	const prev = await readState(env.STATE);

	if ((await env.STATE.get("test-alert")) !== null) {
		const ok = await send(x, env, {
			title: "Uptime monitor test (Cloudflare)",
			priority: "default",
			tags: "white_check_mark",
			body: "The Cloudflare uptime monitor can reach your phone. This is a test; nothing is down.",
		});
		x.log(`test alert ${ok ? "sent" : "NOT sent"}`);
		if (ok) await env.STATE.delete("test-alert");
	}

	const answer = await liveSites(x, deps.sleep);
	const listed = decideSites(answer, prev?.sites ?? [], prev?.sitesPending ?? null, Date.now());
	const fixed = parseTargets(targetsTxt);
	const targets = [...fixed, ...siteTargets(listed.sites)];
	const reserve = alertReserve({ discord: !!env.DISCORD_WEBHOOK, heartbeat: !!env.HC_URL?.startsWith("https://hc-ping.com/") });
	const checked = await checkAll(x, targets, budget, reserve, deps.sleep);
	// The listing list itself is a pseudo-target: down while /__sites can't be read or can't be believed.
	const listResult = { name: SITES_TARGET, url: SITES_URL, up: listed.source === "live", why: listed.note };
	const now = new Date().toISOString();
	const results = withSince(
		[...checked.slice(0, fixed.length), listResult, ...checked.slice(fixed.length)],
		prev?.targets ?? [],
		now,
	);

	// Alerts first, now that the failures are known: they have budget kept for them, and nothing else goes before.
	const down = results.filter((r) => !r.up && !r.unknown).map((r) => r.name);
	const unknown = results.filter((r) => r.unknown).map((r) => r.name);
	const alerts = decideAlerts(down, prev?.told ?? [], prev?.remindedAt ?? null, Date.now(), {
		unknown,
		checked: results.map((r) => r.name),
	});
	// "Not answering: live-listings" alone would hide that it DID answer, with a list that can't be believed.
	for (const a of alerts) if (a.kind !== "back" && a.names.includes(SITES_TARGET) && listed.note) a.body += ` (${SITES_TARGET}: ${listed.note}.)`;
	const sent: Alert[] = [];
	for (const a of alerts) if (await send(x, env, a)) sent.push(a);
	const next = afterAlerts(prev?.told ?? [], prev?.remindedAt ?? null, sent, down, now);

	await heartbeat(x, env, results);

	const state: State = {
		v: 1,
		checkedAt: now,
		ms: Date.now() - started,
		sitesSource: listed.source,
		sitesNote: listed.note,
		sites: listed.sites,
		sitesPending: listed.pending,
		subrequests: budget.used + KV_OPS,
		targets: results,
		told: next.told,
		remindedAt: next.remindedAt,
	};
	await env.STATE.put("state", JSON.stringify(state));
	for (const r of results) {
		const word = r.up ? "up     " : r.unknown ? "unknown" : "DOWN   ";
		x.log(`${word}  ${r.name}${r.up ? "" : `  (${r.url})  ${r.why}`}`);
	}
	for (const a of alerts) x.log(`alert ${a.kind}: ${sent.includes(a) ? "sent" : "NOT sent"}`);
	x.log(`subrequests: ${budget.used} fetches + up to ${KV_OPS} KV calls, of ${SUBREQUEST_LIMIT}`);
	return state;
}

/** What /status shows. No secrets in here: target names, public URLs, up/down and times only. */
export function statusBody(s: State | null): Record<string, unknown> {
	if (!s) return { checkedAt: null, note: "no run recorded yet" };
	return {
		checkedAt: s.checkedAt,
		ms: s.ms,
		schedule: "*/5 * * * *",
		sitesSource: s.sitesSource,
		sitesNote: s.sitesNote ?? "",
		sitesPending: s.sitesPending ?? null,
		subrequests: s.subrequests ?? null,
		allUp: s.targets.every((t) => t.up),
		targets: s.targets,
		alerted: s.told,
	};
}
