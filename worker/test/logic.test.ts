import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	MAX_ALERTS_PER_RUN,
	REMIND_EVERY_MS,
	SITES_CONFIRM_MS,
	Budget,
	afterAlerts,
	alertReserve,
	attemptOk,
	decideAlerts,
	decideSites,
	parseSites,
	parseTargets,
	siteTargets,
	suspiciousSites,
	withSince,
} from "../src/logic.ts";

test("targets.txt: the launcher and every public product, each on one https health URL", () => {
	const t = parseTargets(readFileSync(new URL("../../targets.txt", import.meta.url), "utf8"));
	assert.deepEqual(
		t.map((x) => x.name),
		[
			"launcher",
			"casitatolsa",
			"mcardapp",
			"hearth-crm",
			"options-desk",
			"tucsonexperts",
			"comp-helper",
			"leads-engine",
			"adtracker",
			"invest",
			"project-desk",
			"arr-home",
			"starspoken",
			"tech2door",
			"zipline",
			"meal-plan",
			"tg-bot",
		],
	);
	assert.deepEqual(t[0], { name: "launcher", url: "https://launcher.zeezey.org/login", want: "Listing Launcher" });
	assert.deepEqual(t.find((x) => x.name === "options-desk"), {
		name: "options-desk",
		url: "https://desk.zeezey.org/api/system/health/deep",
		want: '"ok":true',
	});
	for (const x of t) {
		assert.match(x.url, /^https:\/\/[a-z0-9.-]+\//, x.name);
		assert.ok(x.want.length >= 5, `${x.name}: a want text that means something`);
	}
	assert.equal(new Set(t.map((x) => x.name)).size, t.length, "names are unique");
	// A listing slug can't collide with a fixed name: slugs start with the street number.
	assert.ok(t.every((x) => !/^\d/.test(x.name)));
});

test("a want text with spaces survives", () => {
	assert.deepEqual(parseTargets("a  https://x/  Two Words\r\n# c\n\n"), [{ name: "a", url: "https://x/", want: "Two Words" }]);
});

test("/__sites: slugs only, sorted and unique; the wrong shape is unreadable", () => {
	assert.deepEqual(parseSites({ sites: ["b-2", "a-1", "a-1", "../x", 5, "Up"] }), ["a-1", "b-2"]);
	assert.equal(parseSites({}), null);
	assert.equal(parseSites(null), null);
	// An empty list READS fine -- but decideSites does not believe it (next tests).
	assert.deepEqual(parseSites({ sites: [] }), []);
});

const KNOWN = ["a-1", "b-2", "c-3", "d-4", "e-5"];
const T0 = Date.parse("2026-10-10T16:00:00Z");

test("an EMPTY /__sites list is not believed: the last list is kept and the source is degraded", () => {
	const d = decideSites([], KNOWN, null, T0);
	assert.deepEqual(d.sites, KNOWN);
	assert.equal(d.source, "degraded");
	assert.match(d.note, /EMPTY list \(the last one had 5\)/);
	assert.deepEqual(d.pending, { sites: [], since: new Date(T0).toISOString() });
});

test("a list that lost more than half of the last one is not believed; half or less is", () => {
	assert.match(suspiciousSites(["a-1", "b-2"], KNOWN) ?? "", /dropped 3 of the last 5 listings \(c-3, d-4, e-5\)/);
	assert.equal(decideSites(["a-1", "b-2"], KNOWN, null, T0).source, "degraded");
	// A wholly different list of the same size is a drop of everything.
	assert.equal(decideSites(["v-1", "w-2", "x-3", "y-4", "z-5"], KNOWN, null, T0).source, "degraded");
	const ok = decideSites(["a-1", "b-2", "c-3"], KNOWN, null, T0);
	assert.deepEqual([ok.source, ok.sites, ok.pending], ["live", ["a-1", "b-2", "c-3"], null]);
	assert.equal(decideSites([...KNOWN, "f-6"], KNOWN, null, T0).source, "live", "growth is always fine");
	assert.equal(decideSites([], [], null, T0).source, "live", "empty after empty is the truth");
});

test("a suspicious list is believed once it has held, unchanged, for an hour", () => {
	const first = decideSites(["a-1"], KNOWN, null, T0);
	const later = decideSites(["a-1"], KNOWN, first.pending, T0 + SITES_CONFIRM_MS - 1);
	assert.equal(later.source, "degraded");
	assert.equal(later.pending?.since, first.pending?.since, "the clock is not restarted by the same answer");
	const held = decideSites(["a-1"], KNOWN, later.pending, T0 + SITES_CONFIRM_MS);
	assert.deepEqual([held.source, held.sites, held.pending], ["live", ["a-1"], null]);
	assert.match(held.note, /accepted after it held for an hour/);
	// A DIFFERENT suspicious answer starts the hour again.
	const other = decideSites(["b-2"], KNOWN, later.pending, T0 + SITES_CONFIRM_MS);
	assert.equal(other.source, "degraded");
	assert.equal(other.pending?.since, new Date(T0 + SITES_CONFIRM_MS).toISOString());
});

test("/__sites unreadable: the last list (or none), and a waiting answer keeps waiting", () => {
	const pending = { sites: [], since: "2026-10-10T15:00:00.000Z" };
	assert.deepEqual(decideSites(null, KNOWN, pending, T0), {
		sites: KNOWN,
		source: "last-known",
		note: "/__sites could not be read: checked the last known list",
		pending,
	});
	assert.equal(decideSites(null, [], null, T0).source, "none");
});

test("the budget refuses the subrequest past its limit; the alerts' share is kept back", () => {
	const b = new Budget(3);
	assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
	assert.deepEqual([b.used, b.left()], [3, 0]);
	assert.equal(alertReserve({ discord: true, heartbeat: true }), MAX_ALERTS_PER_RUN * 2 + 1);
	assert.equal(alertReserve({ discord: false, heartbeat: false }), MAX_ALERTS_PER_RUN);
});

test("a listing must answer 200 with its page shell", () => {
	assert.deepEqual(siteTargets(["10071-s-x"]), [
		{ name: "10071-s-x", url: "https://10071-s-x.tucsonexperts.com/", want: "<title>" },
	]);
	assert.equal(attemptOk(200, "<html><title>x</title>", "<title>"), true);
	assert.equal(attemptOk(404, "<title>Not available</title>", "<title>"), false);
	assert.equal(attemptOk(200, "challenge page", "<title>"), false);
	assert.equal(attemptOk(301, "", "<title>"), false);
});

test("since carries forward while the state holds and resets on a change", () => {
	const prev = [
		{ name: "a", url: "u", up: true, why: "", since: "T0" },
		{ name: "b", url: "u", up: true, why: "", since: "T0" },
	];
	const r = withSince(
		[
			{ name: "a", url: "u", up: true, why: "" },
			{ name: "b", url: "u", up: false, why: "status=522" },
			{ name: "c", url: "u", up: true, why: "" },
		],
		prev,
		"T1",
	);
	assert.deepEqual(r.map((x) => x.since), ["T0", "T1", "T1"]);
	// Going from down to "not checked" is a change too.
	const u = withSince([{ name: "b", url: "u", up: false, unknown: true, why: "" }], r, "T2");
	assert.equal(u[0].since, "T2");
});

const NOW = Date.parse("2026-10-03T16:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

test("all up and nothing told: silence", () => {
	assert.deepEqual(decideAlerts([], [], null, NOW), []);
});

test("went down: one DOWN alert naming only the new ones", () => {
	const a = decideAlerts(["a", "b"], ["a"], iso(NOW - 10 * 60_000), NOW);
	assert.equal(a.length, 1);
	assert.equal(a[0].kind, "down");
	assert.deepEqual(a[0].names, ["b"]);
	assert.match(a[0].body, /Not answering: b\./);
	assert.equal(a[0].priority, "high");
});

test("came back: one recovered alert", () => {
	const a = decideAlerts([], ["a"], iso(NOW - 10 * 60_000), NOW);
	assert.deepEqual(a.map((x) => x.kind), ["back"]);
	assert.deepEqual(a[0].names, ["a"]);
});

test("still down: a reminder only once an hour has passed since the last one", () => {
	assert.deepEqual(decideAlerts(["a"], ["a"], iso(NOW - 30 * 60_000), NOW), []);
	const a = decideAlerts(["a"], ["a"], iso(NOW - REMIND_EVERY_MS), NOW);
	assert.deepEqual(a.map((x) => x.kind), ["still"]);
});

test("no reminder in a run that already sent a DOWN alert", () => {
	const a = decideAlerts(["a", "b"], ["a"], iso(NOW - 2 * REMIND_EVERY_MS), NOW);
	assert.deepEqual(a.map((x) => x.kind), ["down"]);
});

test("an alert that failed to send leaves told alone, so the next run sends it again", () => {
	const alerts = decideAlerts(["a"], [], null, NOW);
	const nothingSent = afterAlerts([], null, [], ["a"], iso(NOW));
	assert.deepEqual(nothingSent, { told: [], remindedAt: null });
	assert.deepEqual(decideAlerts(["a"], nothingSent.told, nothingSent.remindedAt, NOW + 5 * 60_000).map((x) => x.kind), [
		"down",
	]);
	const sent = afterAlerts([], null, alerts, ["a"], iso(NOW));
	assert.deepEqual(sent, { told: ["a"], remindedAt: iso(NOW) });
});

test("a told target that wasn't checked this run is not 'back up'", () => {
	assert.deepEqual(decideAlerts([], ["a"], iso(NOW - 10 * 60_000), NOW, { unknown: ["a"], checked: ["a"] }), []);
});

test("a told target that is no longer checked at all is reported as such, not as recovered", () => {
	const a = decideAlerts([], ["a", "gone-1"], iso(NOW - 10 * 60_000), NOW, { checked: ["a", "b"] });
	assert.deepEqual(a.map((x) => x.kind), ["back"]);
	assert.deepEqual(a[0].names, ["a", "gone-1"]);
	assert.match(a[0].body, /^Recovered: a\. No longer checked \(off the live listing list\): gone-1\./);
	assert.equal(a[0].title, "Home sites back up");
	const only = decideAlerts([], ["gone-1"], null, NOW, { checked: ["a"] });
	assert.equal(only[0].title, "Home sites no longer checked");
	assert.doesNotMatch(only[0].body, /Recovered/);
});

test("everything recovered and told: the reminder clock resets", () => {
	const alerts = decideAlerts([], ["a"], iso(NOW - 10 * 60_000), NOW);
	assert.deepEqual(afterAlerts(["a"], iso(NOW - 10 * 60_000), alerts, [], iso(NOW)), { told: [], remindedAt: null });
});

test("comp-helper: its real healthz answer (2026-10-24) passes, a false storageOk or jobsOk does not", () => {
	const t = parseTargets(readFileSync(new URL("../../targets.txt", import.meta.url), "utf8")).find((x) => x.name === "comp-helper");
	assert.ok(t);
	const body =
		'{"ok":true,"storage":"disk","storageOk":true,"jobsOk":true,"jobs":{},"backup":"unknown","volume":{"state":"adopted"},' +
		'"disk":{"writable":true,"freeMb":34505,"lowSpace":false}}';
	assert.equal(attemptOk(200, body, t.want), true);
	assert.equal(attemptOk(200, body.replace('"storageOk":true', '"storageOk":false'), t.want), false);
	assert.equal(attemptOk(200, body.replace('"jobsOk":true', '"jobsOk":false'), t.want), false);
	assert.equal(attemptOk(503, body, t.want), false);
});
