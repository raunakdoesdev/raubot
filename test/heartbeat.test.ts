import assert from "node:assert/strict";
import { active, capDigest, decide, DEFAULT, dueTasks, duration, empty, input, judge, nextTick, parse, scrub, strip, type State } from "../src/core/heartbeat.ts";

// durations
assert.equal(duration("30m"), 1_800_000); assert.equal(duration("2h"), 7_200_000); assert.equal(duration("1h30m"), 5_400_000); assert.equal(duration("x"), undefined);
// strip / ack contract
assert.deepEqual(strip("HEARTBEAT_OK"), { text: "", had: true });
assert.deepEqual(strip("**HEARTBEAT_OK**"), { text: "", had: true });
assert.deepEqual(strip("HEARTBEAT_OK. moved Andrew 1:1"), { text: "moved Andrew 1:1", had: true });
assert.deepEqual(strip("Baseten overdue. HEARTBEAT_OK"), { text: "Baseten overdue.", had: true });
assert.equal(strip("say HEARTBEAT_OK when done, ok?").had, false);
assert.deepEqual(judge("HEARTBEAT_OK"), { kind: "ok", text: "" });
assert.deepEqual(judge("NO_REPLY"), { kind: "ok", text: "" });
assert.deepEqual(judge("HEARTBEAT_OK\nMoved Andrew 1:1 to Tue 3pm."), { kind: "ok", text: "Moved Andrew 1:1 to Tue 3pm." });
assert.equal(judge("HEARTBEAT_OK " + "x".repeat(301)).kind, "alert");
assert.equal(judge("HEARTBEAT_OK " + "x".repeat(300)).kind, "ok");
assert.deepEqual(judge("Luther needs your OK on the flight."), { kind: "alert", text: "Luther needs your OK on the flight." });
assert.equal(judge("Reply HEARTBEAT_OK in the middle means nothing.").kind, "alert");
assert.equal(scrub("Done.\nHEARTBEAT_OK"), "Done."); assert.equal(scrub("plain"), "plain");
// active hours, PT (PDT = UTC-7)
const w = DEFAULT.activeHours;
assert.equal(active(Date.parse("2026-10-07T14:00:00Z"), w), true); // 07:00
assert.equal(active(Date.parse("2026-10-07T13:59:00Z"), w), false); // 06:59
assert.equal(active(Date.parse("2026-10-08T05:59:00Z"), w), true); // 22:59
assert.equal(active(Date.parse("2026-10-08T06:00:00Z"), w), false); // 23:00
assert.equal(active(Date.parse("2026-10-08T06:30:00Z"), { start: "22:00", end: "06:00", tz: "America/Los_Angeles" }), true);
// next tick: +30m inside, else next 07:00
assert.equal(nextTick(Date.parse("2026-10-07T17:00:00Z"), DEFAULT), Date.parse("2026-10-07T17:30:00Z"));
assert.equal(nextTick(Date.parse("2026-10-08T05:45:00Z"), DEFAULT), Date.parse("2026-10-08T14:00:00Z"));
// decide: coalescing (nextDue far in the past fires once, re-anchored on now), busy defers, quiet skips, pause waits
const s = (o: Partial<State>): State => ({ ...DEFAULT, tasks: {}, ...o });
const now = Date.parse("2026-10-07T18:00:00Z");
assert.deepEqual(decide(now, s({ nextDue: now - 5 * 3_600_000 }), false), { act: "fire", at: now + 1_800_000 });
assert.equal(decide(now, s({ nextDue: now - 1 }), true).act, "defer");
assert.equal(decide(now, s({ nextDue: now + 1000 }), false).act, "wait");
const night = Date.parse("2026-10-08T09:00:00Z"); // 02:00 PT
assert.deepEqual(decide(night, s({ nextDue: night - 1 }), false), { act: "quiet", at: Date.parse("2026-10-08T14:00:00Z") });
assert.equal(decide(night, s({ nextDue: night - 1, wanted: true }), false).act, "fire"); // manual run ignores hours
assert.equal(decide(now, s({ nextDue: now - 1, paused: true }), false).act, "wait");
assert.equal(decide(now, s({ paused: true, wanted: true }), true).act, "defer");
// empty-file skip
assert.equal(empty("# Heartbeat\n\n<!-- nothing yet -->\n- [ ]\n-\n"), true);
assert.equal(empty("# H\n- Check Slack DMs"), false);
assert.equal(empty("tasks:\n"), true);
// tasks block + due selection
const md = "# Heartbeat\nRules: alerts only.\n\ntasks:\n  - name: slack\n    every: 30m\n    prompt: Check Slack DMs\n  - name: vanta\n    every: 2h\n    prompt: Check Vanta\n\n## Rules\n- never send as him\n";
const p = parse(md);
assert.deepEqual(p.tasks.map((x) => [x.name, x.every, x.prompt]), [["slack", 1_800_000, "Check Slack DMs"], ["vanta", 7_200_000, "Check Vanta"]]);
assert.ok(p.body.includes("Rules: alerts only.") && p.body.includes("never send as him") && !p.body.includes("Check Vanta"));
assert.deepEqual(dueTasks(p.tasks, {}, now).map((x) => x.name), ["slack", "vanta"]);
assert.deepEqual(dueTasks(p.tasks, { slack: now - 1_790_000, vanta: now - 3_600_000 }, now).map((x) => x.name), ["slack"]);
assert.deepEqual(dueTasks(p.tasks, { slack: now - 60_000, vanta: now - 3_600_000 }, now).map((x) => x.name), []);
// input + digest cap
const inp = input({ stamp: "S", md: "M", due: [p.tasks[0]], digest: "D" });
assert.ok(inp.startsWith("[heartbeat] S. Read HEARTBEAT.md") && inp.includes("- slack: Check Slack DMs") && inp.includes("\nD\n"));
assert.ok(capDigest("x".repeat(13_000)).length < 12_100);
console.log("heartbeat tests ok");
