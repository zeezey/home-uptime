// The parts of the monitor that decide things, kept free of fetch/KV so they can be tested with plain
// `node --test`. index.ts does the I/O.

export const DOMAIN = "tucsonexperts.com";
export const SITES_URL = `https://sites.${DOMAIN}/__sites`;
export const REMIND_EVERY_MS = 60 * 60_000;

export interface Target {
	name: string;
	url: string;
	want: string;
}

export interface TargetResult {
	name: string;
	url: string;
	up: boolean;
	/** Why it is down: status code, Cloudflare's verdict header, or the fetch error. Empty when up. */
	why: string;
	/** When the current up/down state began (ISO). */
	since: string;
}

export interface State {
	v: 1;
	checkedAt: string;
	ms: number;
	sitesSource: "live" | "last-known" | "none";
	sites: string[];
	targets: TargetResult[];
	/** The names the phone was last told are down: the alert diff runs against this, not the last check. */
	told: string[];
	/** When the last down / still-down alert went out (ISO), null while everything is up. */
	remindedAt: string | null;
}

/** targets.txt: `<name> <url> <text the page must contain>`, `#` comments, blank lines ignored. */
export function parseTargets(text: string): Target[] {
	const out: Target[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = /^(\S+)\s+(\S+)\s+(.+)$/.exec(line);
		if (m) out.push({ name: m[1], url: m[2], want: m[3].trim() });
	}
	return out;
}

/** The listing server's /__sites answer → slugs (only the shapes a slug can have). Null when it isn't usable. */
export function parseSites(body: unknown): string[] | null {
	const sites = (body as { sites?: unknown } | null)?.sites;
	if (!Array.isArray(sites)) return null;
	const ok = sites.filter((s): s is string => typeof s === "string" && /^[a-z0-9-]+$/.test(s));
	return [...new Set(ok)].sort();
}

/** A live listing must answer 200 with its page shell; the "not available" page for a missing site is a 404. */
export function siteTargets(slugs: string[]): Target[] {
	return slugs.map((slug) => ({ name: slug, url: `https://${slug}.${DOMAIN}/`, want: "<title>" }));
}

/** One attempt passes on HTTP 200 with the expected text in the body (curl -f without -L, as check.sh did). */
export function attemptOk(status: number, body: string, want: string): boolean {
	return status === 200 && body.includes(want);
}

/** Carry each target's `since` forward while its state holds. */
export function withSince(results: Omit<TargetResult, "since">[], prev: TargetResult[], now: string): TargetResult[] {
	const before = new Map(prev.map((r) => [r.name, r]));
	return results.map((r) => {
		const p = before.get(r.name);
		return { ...r, since: p && p.up === r.up ? p.since : now };
	});
}

export interface Alert {
	kind: "down" | "back" | "still";
	title: string;
	priority: "high" | "default";
	tags: string;
	body: string;
	names: string[];
}

const SOURCE = "(Cloudflare monitor, every 5 min)";

/**
 * What to send this run, same rules as the GitHub workflow: on CHANGE (went down / came back) plus an hourly
 * reminder while anything stays down. `told` is what the phone already knows, so an alert that fails to send is
 * simply sent again next run (the caller only moves `told` for alerts that went out).
 */
export function decideAlerts(down: string[], told: string[], remindedAt: string | null, now: number): Alert[] {
	const isDown = new Set(down);
	const knew = new Set(told);
	const went = down.filter((n) => !knew.has(n));
	const back = told.filter((n) => !isDown.has(n));
	const out: Alert[] = [];
	if (went.length) {
		out.push({
			kind: "down",
			title: "Home sites DOWN",
			priority: "high",
			tags: "rotating_light",
			body: `Not answering: ${went.join(", ")}. If everything is down at once, the house (power/internet) or Tower is the likely cause. ${SOURCE}`,
			names: went,
		});
	}
	if (back.length) {
		out.push({
			kind: "back",
			title: "Home sites back up",
			priority: "default",
			tags: "white_check_mark",
			body: `Recovered: ${back.join(", ")} ${SOURCE}`,
			names: back,
		});
	}
	const last = remindedAt ? Date.parse(remindedAt) : 0;
	if (!went.length && down.length && now - last >= REMIND_EVERY_MS) {
		out.push({
			kind: "still",
			title: "Still down",
			priority: "high",
			tags: "warning",
			body: `Still not answering: ${down.join(", ")} ${SOURCE}`,
			names: down,
		});
	}
	return out;
}

/** Apply the alerts that were actually delivered to `told` / `remindedAt`. */
export function afterAlerts(
	told: string[],
	remindedAt: string | null,
	sent: Alert[],
	down: string[],
	nowIso: string,
): { told: string[]; remindedAt: string | null } {
	const next = new Set(told);
	let reminded = remindedAt;
	for (const a of sent) {
		if (a.kind === "down") {
			for (const n of a.names) next.add(n);
			reminded = nowIso;
		} else if (a.kind === "back") {
			for (const n of a.names) next.delete(n);
		} else {
			reminded = nowIso;
		}
	}
	if (!down.length && !next.size) reminded = null;
	return { told: [...next].sort(), remindedAt: reminded };
}
