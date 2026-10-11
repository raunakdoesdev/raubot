import assert from "node:assert/strict";
import { answer, landed, ownedByVoice, progress, sessionConfig, TAG, TOOLS } from "../src/core/voice.ts";
import { finals } from "../src/core/replies.ts";
type K = "user" | "talk" | "tool" | "echo" | "job" | "devin";
const L = (...xs: [K, string][]) => xs.map(([kind, text]) => ({ kind, text }));
const V = (t: string) => `${TAG} ${t}`;

// A plain voice turn: the reply is voice's.
const a = L(["user", V("what's on my calendar")], ["tool", "codemode"], ["echo", "x"], ["talk", "You have a 4pm."]);
assert.equal(answer(a, 0, V("what's on my calendar"), true), "You have a 4pm.");
assert.equal(answer(a, 0, V("what's on my calendar"), false), undefined, "busy: last talk may not be final");
assert.equal(ownedByVoice(a, 3), true);
// Still queued: no answer, even if the turn looks ended.
assert.equal(answer(L(["user", "older"], ["talk", "hi"]), 0, V("q"), true), undefined);
assert.equal(landed(a, 1, V("what's on my calendar")), -1, "only from start");
// Silent end.
assert.equal(answer(L(["user", V("q")], ["tool", "x"], ["echo", "y"]), 0, V("q"), true), "");

// THE invariant: voice steering into an iMessage turn. iMessage's reply stays iMessage's; voice's never goes to iMessage.
const mix = L(["user", "[via imessage] book golf"], ["tool", "x"], ["talk", "Booked 4:10."], ["user", V("and lunch?")], ["talk", "Trader Joe's salmon."]);
const owed = finals(mix, 0, -1, true).filter((r) => !ownedByVoice(mix, r.at)).map((r) => r.text);
assert.deepEqual(owed, ["Booked 4:10."], "iMessage gets only its own reply");
assert.equal(answer(mix, 0, V("and lunch?"), true), "Trader Joe's salmon.");
// iMessage steering into a voice turn: the voice reply before it is voice's, the later reply is iMessage's.
const mix2 = L(["user", V("status?")], ["talk", "All quiet."], ["user", "[via imessage] thanks"], ["talk", "Anytime."]);
assert.deepEqual(finals(mix2, 0, -1, true).filter((r) => !ownedByVoice(mix2, r.at)).map((r) => r.text), ["Anytime."]);
assert.equal(answer(mix2, 0, V("status?"), true), "All quiet.");
// Merged input with any voice part: never leaks to a channel.
const merged = L(["user", "[via imessage] hi\n\n" + V("hey")], ["talk", "hello"]);
assert.equal(ownedByVoice(merged, 1), true);

assert.ok(progress(a, 0).every((s) => !s.startsWith("user")));
const cfg = sessionConfig("gpt-realtime");
assert.equal(cfg.session.model, "gpt-realtime");
assert.deepEqual(TOOLS.map((t) => t.name), ["ask_raubot", "raubot_wait", "raubot_status"]);
console.log("voice ok");
