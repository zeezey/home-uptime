// The parts of the monitor that decide things, kept free of fetch/KV so they can be tested with plain
// `node --test`. index.ts does the I/O.

export const DOMAIN = "tucsonexperts.com";
export const SITES_URL = `https://sites.${DOMAIN}/__sites`;
export const REMIND_EVERY_MS = 60 * 60_000;
/** The listing list itself, as a pseudo-target: down while /__sites can't be read or its answer can't be trusted. */
export const SITES_TARGET = "live-listings";
/** A suspicious /__sites answer (see decideSites) is accepted once it has held, unchanged, this long. */
export const SITES_CONFIRM_MS = 60 * 60_000;

/**
 * The Workers Free plan allows 50 subrequests per invocation. KV calls are "internal services" with their own
 * 1,000 (developers.cloudflare.com/workers/platform/limits/#subrequests), but the run keeps room for its own KV
 * calls (read state, read + delete test-alert, write state) inside the 50 anyway, so a change in how they are
 * counted can't take the alerts down with it.
 */
export const SUBREQUEST_LIMIT = 50;
export const KV_OPS = 4;
/** decideAlerts sends at most two alerts in a run: down or still-down, plus back-up. */
export const MAX_ALERTS_PER_RUN = 2;

export interface Target {
	name: string;
	url: string;
	want: string;
}

export interface TargetResult {
	name: string;
	url: string;
	up: boolean;
	/**
	 * Not checked this run (no subrequests left for it): neither up nor down. It is not alerted on and does not
	 * count as "back up"; whatever the phone was told about it stands.
	 */
	unknown?: boolean;
	/** Why it is down: status code, Cloudflare's verdict header, or the fetch error. Empty when up. */
	why: string;
	/** When the current up/down state began (ISO). */
	since: string;
}

/**
 * Where this run's listing list came from. `degraded`: /__sites answered, but with a list that can't be trusted
 * (empty, or most of the last list gone), so the last list was checked instead.
 */
export type SitesSource = "live" | "last-known" | "degraded" | "none";

export interface SitesPending {
	/** The suspicious answer, waiting to be believed. */
	sites: string[];
	/** When it was first seen (ISO). */
	since: string;
}

export interface State {
	v: 1;
	checkedAt: string;
	ms: number;
	sitesSource: SitesSource;
	/** Why the source isn't `live`; empty when it is. */
	sitesNote?: string;
	/** The list that was checked: the live answer, or the last trusted one. */
	sites: string[];
	sitesPending?: SitesPending | null;
	/** Subrequests the run used (fetches + KV calls), against SUBREQUEST_LIMIT. */
	subrequests?: number;
	targets: TargetResult[];
	/** The names the phone was last told are down: the alert diff runs against this, not the last check. */
	told: string[];
	/** When the last down / still-down alert went out (ISO), null while everything is up. */
	remindedAt: string | null;
}

/** Counts subrequests and refuses the one past the limit, so a run can never go over it. */
export class Budget {
	used = 0;
	readonly limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}
	left(): number {
		return this.limit - this.used;
	}
	take(): boolean {
		if (this.used >= this.limit) return false;
		this.used++;
		return true;
	}
}

/** Fetches kept back for the alerts and the Healthchecks ping, so the checks can never spend them. */
export function alertReserve(opts: { discord: boolean; heartbeat: boolean }): number {
	return MAX_ALERTS_PER_RUN * (opts.discord ? 2 : 1) + (opts.heartbeat ? 1 : 0);
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

/**
 * The listing server's /__sites answer → slugs (only the shapes a slug can have). Null when it isn't the right
 * shape. This only reads the answer; whether to BELIEVE it (an empty list, say) is decideSites's call.
 */
export function parseSites(body: unknown): string[] | null {
	const sites = (body as { sites?: unknown } | null)?.sites;
	if (!Array.isArray(sites)) return null;
	const ok = sites.filter((s): s is string => typeof s === "string" && /^[a-z0-9-]+$/.test(s));
	return [...new Set(ok)].sort();
}

/**
 * Why a /__sites answer can't be taken as is, or null when it can: it is empty, or more than half of the last
 * trusted list is missing from it. A listing server that lost its data (a volume not mounted, a bad release)
 * answers exactly like that, and believing it would quietly stop checking the very sites that are broken.
 */
export function suspiciousSites(answer: string[], known: string[]): string | null {
	if (!known.length) return null;
	const kept = new Set(answer);
	const gone = known.filter((s) => !kept.has(s));
	if (gone.length * 2 <= known.length) return null;
	if (!answer.length) return `/__sites answered an EMPTY list (the last one had ${known.length})`;
	return `/__sites dropped ${gone.length} of the last ${known.length} listings (${gone.join(", ")})`;
}

export interface SitesDecision {
	/** The listings to check this run. */
	sites: string[];
	source: SitesSource;
	note: string;
	pending: SitesPending | null;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * Which listings to check. `answer` is the parsed /__sites answer (null: it couldn't be read), `known` the last
 * list that was trusted. A suspicious answer keeps the known list and marks the source `degraded` (the caller
 * shows that as the SITES_TARGET pseudo-target being down, so it is alerted on); the same answer, unchanged for
 * SITES_CONFIRM_MS, is believed after all -- retiring most listings at once is real sometimes, and must not
 * leave the monitor checking retired sites for ever.
 */
export function decideSites(
	answer: string[] | null,
	known: string[],
	pending: SitesPending | null,
	nowMs: number,
): SitesDecision {
	if (answer === null) {
		return known.length
			? { sites: known, source: "last-known", note: "/__sites could not be read: checked the last known list", pending }
			: { sites: [], source: "none", note: "/__sites could not be read and there is no earlier list", pending };
	}
	const why = suspiciousSites(answer, known);
	if (!why) return { sites: answer, source: "live", note: "", pending: null };
	const held = pending && sameList(pending.sites, answer) ? pending : { sites: answer, since: new Date(nowMs).toISOString() };
	if (nowMs - Date.parse(held.since) >= SITES_CONFIRM_MS) {
		return { sites: answer, source: "live", note: `accepted after it held for an hour: ${why}`, pending: null };
	}
	return {
		sites: known,
		source: "degraded",
		note: `${why}; still checking the last ${known.length} until the new list holds for an hour`,
		pending: held,
	};
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
		return { ...r, since: p && p.up === r.up && !p.unknown === !r.unknown ? p.since : now };
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
 *
 * `unknown`: names not checked this run -- not "back up", whatever the phone was told stands. `checked`: every
 * name this run looked at; a told name that is no longer among them (a listing taken off the live list) is
 * reported as no longer checked, not as recovered.
 */
export function decideAlerts(
	down: string[],
	told: string[],
	remindedAt: string | null,
	now: number,
	opts: { unknown?: string[]; checked?: string[] } = {},
): Alert[] {
	const isDown = new Set(down);
	const knew = new Set(told);
	const notChecked = new Set(opts.unknown ?? []);
	const checked = opts.checked ? new Set(opts.checked) : null;
	const went = down.filter((n) => !knew.has(n));
	const back = told.filter((n) => !isDown.has(n) && !notChecked.has(n));
	const recovered = back.filter((n) => !checked || checked.has(n));
	const gone = back.filter((n) => checked && !checked.has(n));
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
		const said = [
			recovered.length ? `Recovered: ${recovered.join(", ")}.` : "",
			gone.length ? `No longer checked (off the live listing list): ${gone.join(", ")}.` : "",
		];
		out.push({
			kind: "back",
			title: recovered.length ? "Home sites back up" : "Home sites no longer checked",
			priority: "default",
			tags: "white_check_mark",
			body: `${said.filter(Boolean).join(" ")} ${SOURCE}`,
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
