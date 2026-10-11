import { finals } from "../src/core/replies.ts";
import assert from "node:assert/strict";
type K = "user" | "talk" | "tool" | "echo" | "job" | "devin";
const L = (...xs: [K, string][]) => xs.map(([kind, text]) => ({ kind, text }));
const at = (r: { at: number }[]) => r.map((x) => x.at);

// The 5639 bug: a reply finished, then a second iMessage steered into the same turn. Both replies are owed.
const log = L(["user", "juro?"], ["tool", "codemode"], ["echo", "job 348"], ["talk", "Juro plan"], ["user", "cave!"], ["talk", "Glad the cave"]);
assert.deepEqual(at(finals(log, 0, -1, true)), [3, 5]);
// While still busy, the first is already final and can go out right away; the second waits for the turn to end.
assert.deepEqual(at(finals(log, 0, -1, false)), [3]);
// Already sent the first: only the second, never twice.
assert.deepEqual(at(finals(log, 0, 3, true)), [5]);
assert.deepEqual(at(finals(log, 0, 5, true)), []);
// Narration before a tool call is not a reply.
const nar = L(["user", "q"], ["talk", "Let me check"], ["tool", "x"], ["echo", "y"], ["talk", "Answer"]);
assert.deepEqual(at(finals(nar, 0, -1, true)), [4]);
assert.deepEqual(at(finals(nar, 0, -1, false)), []);
// A message steered in after a tool result (no reply in between) owes nothing extra.
const st = L(["user", "a"], ["tool", "x"], ["echo", "y"], ["user", "b"], ["talk", "both"]);
assert.deepEqual(at(finals(st, 0, -1, true)), [4]);
// Silent turn: nothing to send.
assert.deepEqual(at(finals(L(["user", "a"], ["tool", "x"], ["echo", "y"]), 0, -1, true)), []);
// Older talk before start is ignored.
assert.deepEqual(at(finals(L(["talk", "old"], ["user", "a"], ["talk", "new"]), 1, -1, true)), [2]);
console.log("replies ok");
