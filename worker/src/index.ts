// home-uptime, the Cloudflare half: checks the launcher and every live listing every 5 minutes from Cloudflare's
// network (outside the house), and alerts the phone through ntfy when something goes down, hourly while it stays
// down, and once when it comes back. The GitHub workflow beside it does the same job but GitHub runs its */10
// schedule only every 3-5 hours, so this is the one that keeps time.
//
// Unlike the GitHub runner, a Worker's fetch is not challenged by Bot Fight Mode (proved 2026-10-03: 200 with the
// real page on every target), so it checks the sites the way a visitor reaches them -- through Cloudflare -- and a
// dead house shows up as Cloudflare's 52x errors. `cache: "no-store"` keeps an edge copy from answering for a dead
// origin.
//
// State is one KV key, `state` (see logic.ts State), written once per run: 288 writes a day, under the free plan's
// 1,000. Putting any value under the KV key `test-alert` makes the next run send one test alert and delete it.
import targetsTxt from "../../targets.txt?raw";
import {
	SITES_URL,
	afterAlerts,
	attemptOk,
	decideAlerts,
	parseSites,
	parseTargets,
	siteTargets,
	withSince,
	type Alert,
	type State,
	type Target,
	type TargetResult,
} from "./logic.ts";

interface Env {
	STATE: KVNamespace;
	/** The ntfy URL (same as the launcher's LAUNCHER_ALERT_WEBHOOK). */
	ALERT_WEBHOOK: string;
	/** Optional ntfy.sh account token: without one, ntfy.sh refuses Workers (see send()). */
	NTFY_TOKEN?: string;
	/** Discord webhook, used when ntfy refuses (the one Tower's Unraid notifications post to). */
	DISCORD_WEBHOOK?: string;
}

const UA = "home-uptime (cloudflare worker)";
const ATTEMPTS = 3;
const RETRY_MS = 20_000;
const TIMEOUT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<{ status: number; body: string; why: string }> {
	try {
		const r = await fetch(url, {
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

/** Down only after THREE failures 20 s apart: one dropped packet should not wake anyone up. */
async function check(t: Target): Promise<Omit<TargetResult, "since">> {
	let why = "";
	for (let i = 1; i <= ATTEMPTS; i++) {
		const r = await get(t.url);
		if (attemptOk(r.status, r.body, t.want)) return { name: t.name, url: t.url, up: true, why: "" };
		why = r.status === 200 ? `status=200 but "${t.want}" is not on the page` : r.why;
		if (i < ATTEMPTS) await sleep(RETRY_MS);
	}
	return { name: t.name, url: t.url, up: false, why };
}

/** Which listings are live, from the listing server itself; null when it can't say (the house may be down). */
async function liveSites(): Promise<string[] | null> {
	for (let i = 1; i <= 2; i++) {
		const r = await get(SITES_URL);
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

async function post(channel: string, title: string, url: string, init: RequestInit): Promise<boolean> {
	try {
		const r = await fetch(url, { ...init, method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (r.ok) console.log(`alert "${title}" delivered via ${channel}`);
		else console.log(`alert "${title}" refused by ${channel}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
		return r.ok;
	} catch (e) {
		console.log(`alert "${title}" failed via ${channel}: ${e}`);
		return false;
	}
}

/**
 * ntfy first (the phone channel the GitHub workflow uses), Discord when ntfy refuses. Anonymous ntfy.sh publishes
 * from a Worker are refused: its daily quota is per IP and Workers share Cloudflare's IPs ("daily message quota
 * reached", 0 of 8 accepted on 2026-10-03). An ntfy.sh account token (secret NTFY_TOKEN) gives a per-user quota;
 * until one is set, alerts arrive through Discord (secret DISCORD_WEBHOOK, the channel Tower's own alerts use).
 */
async function send(env: Env, a: { title: string; priority: string; tags: string; body: string }): Promise<boolean> {
	const headers: Record<string, string> = { Title: a.title, Priority: a.priority, Tags: a.tags };
	if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
	if (await post("ntfy", a.title, env.ALERT_WEBHOOK, { headers, body: a.body })) return true;
	if (!env.DISCORD_WEBHOOK) return false;
	const icon = a.priority === "high" ? "🚨 " : a.tags === "white_check_mark" ? "✅ " : "";
	return post("discord", a.title, env.DISCORD_WEBHOOK, {
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content: `${icon}**${a.title}**\n${a.body}`.slice(0, 1900), allowed_mentions: { parse: [] } }),
	});
}

async function readState(env: Env): Promise<State | null> {
	try {
		return await env.STATE.get<State>("state", "json");
	} catch {
		return null;
	}
}

async function run(env: Env): Promise<State> {
	const started = Date.now();
	const prev = await readState(env);

	if ((await env.STATE.get("test-alert")) !== null) {
		const ok = await send(env, {
			title: "Uptime monitor test (Cloudflare)",
			priority: "default",
			tags: "white_check_mark",
			body: "The Cloudflare uptime monitor can reach your phone. This is a test; nothing is down.",
		});
		console.log(`test alert ${ok ? "sent" : "NOT sent"}`);
		if (ok) await env.STATE.delete("test-alert");
	}

	const live = await liveSites();
	const sites = live ?? prev?.sites ?? [];
	const targets = [...parseTargets(targetsTxt), ...siteTargets(sites)];
	const now = new Date().toISOString();
	const results = withSince(await Promise.all(targets.map(check)), prev?.targets ?? [], now);

	const down = results.filter((r) => !r.up).map((r) => r.name);
	const alerts = decideAlerts(down, prev?.told ?? [], prev?.remindedAt ?? null, Date.now());
	const sent: Alert[] = [];
	for (const a of alerts) if (await send(env, a)) sent.push(a);
	const next = afterAlerts(prev?.told ?? [], prev?.remindedAt ?? null, sent, down, now);

	const state: State = {
		v: 1,
		checkedAt: now,
		ms: Date.now() - started,
		sitesSource: live ? "live" : prev?.sites?.length ? "last-known" : "none",
		sites,
		targets: results,
		told: next.told,
		remindedAt: next.remindedAt,
	};
	await env.STATE.put("state", JSON.stringify(state));
	for (const r of results) console.log(`${r.up ? "up  " : "DOWN"}  ${r.name}${r.up ? "" : `  (${r.url})  ${r.why}`}`);
	for (const a of alerts) console.log(`alert ${a.kind}: ${sent.includes(a) ? "sent" : "NOT sent"}`);
	return state;
}

export default {
	async scheduled(_controller, env: Env) {
		await run(env);
	},

	async fetch(req: Request, env: Env) {
		const { pathname } = new URL(req.url);
		if (pathname === "/status") {
			const s = await readState(env);
			// No secrets in here: target names, public URLs, up/down and times only.
			const body = s
				? {
						checkedAt: s.checkedAt,
						ms: s.ms,
						schedule: "*/5 * * * *",
						sitesSource: s.sitesSource,
						allUp: s.targets.every((t) => t.up),
						targets: s.targets,
						alerted: s.told,
					}
				: { checkedAt: null, note: "no run recorded yet" };
			return Response.json(body, { headers: { "cache-control": "no-store" } });
		}
		return new Response("home-uptime: see /status\n", { status: pathname === "/" ? 200 : 404 });
	},
} satisfies ExportedHandler<Env>;
