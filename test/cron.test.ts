import { next, local, today, grace, stamp, job, SILENT } from "../src/core/cron.ts";
import assert from "node:assert/strict";
const tz = "America/Los_Angeles";
const iso = (t?: number) => (t === undefined ? "none" : new Date(t).toISOString());
// Sunday 2026-10-04 22:39 PDT -> weekday 8am = Mon Oct 5 8:00 PDT = 15:00Z
assert.equal(iso(next("0 8 * * 1-5", tz, Date.parse("2026-10-05T05:39:00Z"))), "2026-10-05T15:00:00.000Z");
// Friday 8:00 PDT exactly -> next Monday
assert.equal(iso(next("0 8 * * 1-5", tz, Date.parse("2026-10-09T15:00:00Z"))), "2026-10-12T15:00:00.000Z");
// heartbeat 30 7-22: at 22:31 PDT -> next day 7:30
assert.equal(iso(next("30 7-22 * * *", tz, Date.parse("2026-10-05T05:31:00Z"))), "2026-10-05T14:30:00.000Z");
// DST end Nov 1 2026: 8am PST = 16:00Z
assert.equal(iso(next("0 8 * * *", tz, Date.parse("2026-10-31T16:00:00Z"))), "2026-11-01T16:00:00.000Z");
// DST start Mar 8 2026: 2:30 doesn't exist; 3:00 PDT = 10:00Z
assert.equal(iso(next("0 3 * * *", tz, Date.parse("2026-03-08T08:00:00Z"))), "2026-03-08T10:00:00.000Z");
// steps and lists
assert.equal(iso(next("*/15 * * * *", "UTC", Date.parse("2026-01-01T00:07:00Z"))), "2026-01-01T00:15:00.000Z");
assert.equal(iso(next("0 0 1 1 *", "UTC", Date.parse("2026-06-01T00:00:00Z"))), "2027-01-01T00:00:00.000Z");
// dom OR dow
assert.equal(iso(next("0 9 13 * 5", "UTC", Date.parse("2026-10-05T00:00:00Z"))), "2026-10-09T09:00:00.000Z");
assert.equal(next("0 0 30 2 *", "UTC", 0), undefined);
// one-shot
assert.equal(iso(next("2026-10-05T15:05:00Z", tz, Date.parse("2026-10-05T05:00:00Z"))), "2026-10-05T15:05:00.000Z");
assert.equal(next("2026-10-05T15:05:00Z", tz, Date.parse("2026-10-05T16:00:00Z")), undefined);
assert.throws(() => next("61 * * * *", tz, 0));
assert.throws(() => next("* * *", tz, 0));
assert.equal(today(tz, Date.parse("2026-10-05T05:39:00Z")), "2026-10-04");
assert.equal(local(Date.parse("2026-10-05T15:00:00Z"), tz).dow, 1);
const g = grace({ id: "x", schedule: "0 8 * * 1-5", tz, prompt: "", mode: "agent", channel: "app", timeout: 1, enabled: true }, Date.parse("2026-10-05T15:00:00Z"));
assert.equal(g, 2 * 3600_000);
assert.ok(SILENT.test("HEARTBEAT_OK") && SILENT.test("  ") && SILENT.test("NO_REPLY\n") && !SILENT.test("hi"));
assert.equal(stamp(tz, Date.parse("2026-10-05T15:00:30Z")), "2026-10-05T08:00:00-07:00");
assert.equal(stamp(tz, Date.parse("2026-12-01T16:00:00Z")), "2026-12-01T08:00:00-08:00");
assert.equal(stamp("Asia/Kolkata", Date.parse("2026-10-05T15:00:00Z")), "2026-10-05T20:30:00+05:30");
// The generated job runs: skip, pre-run script, silent and sent paths, with fake tools.
const run = async (code: string, tools: object) => new Function("tools", `return (async () => {${code}})()`)(tools);
const fake = (exit: number, reply: string, sent: string[]) => ({ bash: async () => `x\n[exit ${exit}]`, agent: async ({ task }: { task: string }) => (task.includes("pre-out") ? reply : "no pre"), message: async ({ text }: { text: string }) => void sent.push(text) });
const sent: string[] = [];
const src = 'const t = "it\'s \\"q\\" `b`"; return "pre-out " + NOW + t;';
assert.equal(await run(job({ id: "b", unless: "test -f x", task: "T", channel: "imessage" }, { source: src, now: "N" }), fake(0, "hi", sent)), "SKIPPED b");
assert.equal(await run(job({ id: "b", unless: "test -f x", task: "T", channel: "imessage" }, { source: src, now: "N" }), fake(1, "HEARTBEAT_OK", sent)), "SILENT b");
assert.equal(await run(job({ id: "b", task: "T", channel: "imessage" }, { source: src, now: "N" }), fake(1, "hello", sent)), "SENT b: hello");
assert.equal(await run(job({ id: "b", task: "T", channel: "imessage" }, ""), fake(1, "x", sent)), "SENT b: no pre");
assert.deepEqual(sent, ["hello", "no pre"]);
console.log("cron tests ok");
