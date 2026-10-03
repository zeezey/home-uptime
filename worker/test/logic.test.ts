import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	REMIND_EVERY_MS,
	afterAlerts,
	attemptOk,
	decideAlerts,
	parseSites,
	parseTargets,
	siteTargets,
	withSince,
} from "../src/logic.ts";

test("targets.txt parses to the launcher, comments and blanks skipped", () => {
	const t = parseTargets(readFileSync(new URL("../../targets.txt", import.meta.url), "utf8"));
	assert.deepEqual(t, [{ name: "launcher", url: "https://launcher.zeezey.org/login", want: "Listing Launcher" }]);
});

test("a want text with spaces survives", () => {
	assert.deepEqual(parseTargets("a  https://x/  Two Words\r\n# c\n\n"), [{ name: "a", url: "https://x/", want: "Two Words" }]);
});

test("/__sites: slugs only, sorted and unique; anything else is unusable", () => {
	assert.deepEqual(parseSites({ sites: ["b-2", "a-1", "a-1", "../x", 5, "Up"] }), ["a-1", "b-2"]);
	assert.equal(parseSites({}), null);
	assert.equal(parseSites(null), null);
	assert.deepEqual(parseSites({ sites: [] }), []);
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

test("everything recovered and told: the reminder clock resets", () => {
	const alerts = decideAlerts([], ["a"], iso(NOW - 10 * 60_000), NOW);
	assert.deepEqual(afterAlerts(["a"], iso(NOW - 10 * 60_000), alerts, [], iso(NOW)), { told: [], remindedAt: null });
});
