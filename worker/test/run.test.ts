// Whole runs of the monitor against fake fetch / KV / sleep: an outage must stay inside the Free plan's 50
// subrequests AND still get its alert out; a suspicious listing list must not quietly shrink what is checked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SITES_TARGET, SITES_URL, SUBREQUEST_LIMIT, type State } from "../src/logic.ts";
import { ATTEMPTS, CONNECTIONS, RETRY_MS, run, statusBody, type Deps, type Env } from "../src/run.ts";

const REAL_TARGETS = readFileSync(new URL("../../targets.txt", import.meta.url), "utf8");
const SMALL_TARGETS = "launcher https://launcher.example.org/login Listing Launcher\nshop https://shop.example.com/api/healthz \"ok\":true\n";

const NTFY = "https://ntfy.example/home-sites";
const CHAT = "https://chat.example/hook";
const HC = "https://hc-ping.com/00000000-0000-0000-0000-000000000000";

interface Call {
	url: string;
	method: string;
	body: string;
}

/** A fake world: `answer` decides each request; every fetch, KV call and sleep is recorded. */
function world(answer: (url: string, method: string, nth: number) => Response | Error, kvInit: Record<string, string> = {}) {
	const calls: Call[] = [];
	const nth = new Map<string, number>();
	const sleeps: number[] = [];
	const logs: string[] = [];
	const kv = new Map(Object.entries(kvInit));
	let kvOps = 0;
	const deps: Deps = {
		fetch: async (url, init) => {
			const method = init.method ?? "GET";
			const n = (nth.get(url) ?? 0) + 1;
			nth.set(url, n);
			calls.push({ url, method, body: typeof init.body === "string" ? init.body : "" });
			const a = answer(url, method, n);
			if (a instanceof Error) throw a;
			return a;
		},
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		log: (line) => {
			logs.push(line);
		},
	};
	const env: Env = {
		STATE: {
			get: async (k) => (kvOps++, kv.get(k) ?? null),
			put: async (k, v) => {
				kvOps++;
				kv.set(k, v);
			},
			delete: async (k) => {
				kvOps++;
				kv.delete(k);
			},
		},
		ALERT_WEBHOOK: NTFY,
		DISCORD_WEBHOOK: CHAT,
		HC_URL: HC,
	};
	return {
		deps,
		env,
		calls,
		sleeps,
		logs,
		kv,
		subrequests: () => calls.length + kvOps,
		posts: (to: string) => calls.filter((c) => c.method === "POST" && c.url.startsWith(to)),
		state: () => JSON.parse(kv.get("state") ?? "null") as State,
	};
}

const slugs = (n: number) => Array.from({ length: n }, (_, i) => `${1000 + i}-n-test-street`);

function prevState(sites: string[], told: string[] = []): string {
	const s: State = { v: 1, checkedAt: "2026-10-10T15:55:00.000Z", ms: 0, sitesSource: "live", sites, targets: [], told, remindedAt: null };
	return JSON.stringify(s);
}

const html = (text: string, status = 200) => new Response(text, { status });
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
/** The answer every target gives when it is up. */
function upAnswer(url: string): Response {
	if (url.includes("/api/healthcheck")) return json({ pass: true });
	if (url.includes("/api/lead-health")) return json({ ready: false, routes: { email: false } });
	if (url.includes("comp-helper.")) return json({ ok: true, storage: "disk", storageOk: true, jobsOk: true, jobs: {} });
	if (url.includes("/api/")) return json({ ok: true });
	if (url.includes("launcher")) return html("<title>Listing Launcher</title>");
	if (url === "https://tucsonexperts.com/") return html("<title>Tucson Experts</title>");
	return html("<html><title>A listing</title></html>");
}

/**
 * The worst run there is: the house AND everything else down, /__sites unreadable, a test alert waiting, ntfy
 * refusing every alert (so each one also costs a Discord post), and a "back" alert due on top of the "down" one.
 */
function worstCase(listings: number) {
	const w = world(
		(url, method) => {
			if (method === "POST" && url.startsWith(NTFY)) return html("daily message quota reached", 429);
			if (method === "POST") return new Response(null, { status: 204 });
			return html("error code: 522", 522);
		},
		{ state: prevState(slugs(listings), ["retired-listing"]), "test-alert": "yes" },
	);
	return w;
}

for (const listings of [5, 40]) {
	test(`worst case with ${listings} listings: at most ${SUBREQUEST_LIMIT} subrequests, and the DOWN alert still goes out`, async () => {
		const w = worstCase(listings);
		const state = await run(w.env, REAL_TARGETS, w.deps);

		assert.ok(w.subrequests() <= SUBREQUEST_LIMIT, `${w.subrequests()} subrequests`);
		assert.equal(state.subrequests !== undefined && state.subrequests <= SUBREQUEST_LIMIT, true);

		// The test alert, the DOWN alert and the "no longer checked" alert all reached Discord after ntfy refused.
		const chat = w.posts(CHAT).map((c) => JSON.parse(c.body).content as string);
		assert.equal(chat.length, 3, chat.join("\n"));
		assert.match(chat[0], /Uptime monitor test/);
		assert.match(chat[1], /Home sites DOWN/);
		assert.match(chat[1], /launcher, live-listings, casitatolsa|launcher, casitatolsa/);
		assert.match(chat[2], /No longer checked \(off the live listing list\): retired-listing/);
		assert.equal(w.posts(NTFY).length, 3);
		assert.equal(w.kv.has("test-alert"), false, "a delivered test alert is cleared");

		// The alerts went out before the Healthchecks ping, which still got its /fail.
		const lastAlert = w.calls.findLastIndex((c) => c.url === CHAT);
		const ping = w.calls.findIndex((c) => c.url.startsWith(HC));
		assert.ok(ping > lastAlert, "alerts first");
		assert.equal(w.calls[ping].url, `${HC}/fail`);

		// Nothing is called down without having been tried; what the budget couldn't reach is "unknown".
		const down = state.targets.filter((t) => !t.up && !t.unknown).map((t) => t.name);
		const unknown = state.targets.filter((t) => t.unknown).map((t) => t.name);
		const tried = new Set(w.calls.filter((c) => c.method === "GET").map((c) => c.url));
		for (const t of state.targets) if (!t.unknown && t.name !== SITES_TARGET) assert.ok(tried.has(t.url), `${t.name} was tried`);
		for (const n of unknown) assert.doesNotMatch(chat[1], new RegExp(`\\b${n}\\b`), `${n} (unknown) is not in the DOWN alert`);
		assert.ok(down.includes("launcher") && down.includes("tucsonexperts") && down.includes(SITES_TARGET));
		assert.equal(state.sitesSource, "last-known");
		assert.equal(state.sites.length, listings, "the last list is kept, not replaced");
		if (listings === 5) assert.equal(unknown.length, 0, "with today's list everything gets at least one try");
		else assert.ok(unknown.length > 0);
		assert.deepEqual(state.told, [...down].sort(), "told now holds what is down, and only that");
	});
}

test("all up: one GET per target, the list, the ping -- no retries, no alerts", async () => {
	const w = world((url, method) => (url === SITES_URL ? json({ sites: slugs(5) }) : method === "POST" ? html("ok") : upAnswer(url)), {
		state: prevState(slugs(5)),
	});
	const state = await run(w.env, REAL_TARGETS, w.deps);
	const fixed = REAL_TARGETS.split("\n").filter((l) => l.trim() && !l.startsWith("#")).length;
	assert.equal(w.calls.length, 1 + fixed + 5 + 1);
	assert.deepEqual(w.sleeps, []);
	assert.equal(state.targets.every((t) => t.up), true, JSON.stringify(state.targets.filter((t) => !t.up)));
	assert.deepEqual(w.posts(NTFY), []);
	assert.equal(w.calls.at(-1)?.url, HC, "the plain (all-up) ping");
	assert.equal(statusBody(state).allUp, true);
});

test(`never more than ${CONNECTIONS} requests in flight, so no timeout runs while a request waits in the runtime's queue`, async () => {
	let inFlight = 0;
	let most = 0;
	const w = world((url, method) => (url === SITES_URL ? json({ sites: slugs(10) }) : method === "POST" ? html("ok") : upAnswer(url)), {
		state: prevState(slugs(10)),
	});
	const plain = w.deps.fetch;
	w.deps.fetch = async (url, init) => {
		inFlight++;
		most = Math.max(most, inFlight);
		await new Promise((r) => setTimeout(r, 2));
		try {
			return await plain(url, init);
		} finally {
			inFlight--;
		}
	};
	const state = await run(w.env, REAL_TARGETS, w.deps);
	assert.equal(state.targets.every((t) => t.up), true);
	assert.equal(most, CONNECTIONS);
});

test("a blip is retried 20 s later and is not an outage", async () => {
	const w = world(
		(url, method, n) => {
			if (url === SITES_URL) return json({ sites: [] });
			if (method === "POST") return html("ok");
			if (url.startsWith("https://shop.example.com") && n === 1) return new Error("connection reset");
			return upAnswer(url);
		},
		{ state: prevState([]) },
	);
	const state = await run(w.env, SMALL_TARGETS, w.deps);
	assert.deepEqual(w.sleeps, [RETRY_MS]);
	assert.equal(w.calls.filter((c) => c.url.startsWith("https://shop.example.com")).length, 2);
	assert.equal(state.targets.every((t) => t.up), true);
	assert.deepEqual(w.posts(NTFY), []);
});

test(`a target that stays down is tried ${ATTEMPTS} times before the alert`, async () => {
	const w = world(
		(url, method) => {
			if (url === SITES_URL) return json({ sites: [] });
			if (method === "POST") return html("ok");
			if (url.startsWith("https://shop.example.com")) return html("Bad gateway", 502);
			return upAnswer(url);
		},
		{ state: prevState([]) },
	);
	const state = await run(w.env, SMALL_TARGETS, w.deps);
	assert.equal(w.calls.filter((c) => c.url.startsWith("https://shop.example.com")).length, ATTEMPTS);
	assert.deepEqual(state.told, ["shop"]);
	assert.match(w.posts(NTFY)[0].body, /Not answering: shop\./);
	assert.equal(state.targets.find((t) => t.name === "shop")?.why, "status=502");
});

test("an EMPTY live list keeps the last list checked, marks the source degraded, and alerts", async () => {
	const w = world((url, method) => (url === SITES_URL ? json({ sites: [] }) : method === "POST" ? html("ok") : upAnswer(url)), {
		state: prevState(["a-1", "b-2", "c-3"]),
	});
	const state = await run(w.env, SMALL_TARGETS, w.deps);
	assert.equal(state.sitesSource, "degraded");
	assert.deepEqual(state.sites, ["a-1", "b-2", "c-3"]);
	assert.deepEqual(state.sitesPending?.sites, []);
	for (const s of ["a-1", "b-2", "c-3"]) assert.ok(w.calls.some((c) => c.url === `https://${s}.tucsonexperts.com/`), `${s} still checked`);
	const list = state.targets.find((t) => t.name === SITES_TARGET);
	assert.equal(list?.up, false);
	assert.deepEqual(state.told, [SITES_TARGET]);
	const alert = w.posts(NTFY)[0].body;
	assert.match(alert, /Not answering: live-listings\./);
	assert.match(alert, /EMPTY list \(the last one had 3\)/);
	assert.equal(statusBody(state).allUp, false);
	assert.equal(statusBody(state).sitesSource, "degraded");
});
