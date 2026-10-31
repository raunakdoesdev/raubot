import assert from "node:assert/strict";
import { answer, DEFAULT_MODEL, landed, ownedByVoice, progress, sessionConfig, TAG, TOOLS } from "../src/core/voice.ts";
import { Calls } from "../web/src/lib/realtime.ts";
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
// Model: gpt-realtime-2 only (Raunak). Car-robust turn detection, continuous mic.
assert.equal(DEFAULT_MODEL, "gpt-realtime-2");
const cfg = sessionConfig();
assert.equal(cfg.session.model, "gpt-realtime-2");
assert.equal(cfg.session.audio.input.turn_detection.type, "semantic_vad");
assert.equal(cfg.session.audio.input.turn_detection.eagerness, "low");
assert.equal(cfg.session.audio.input.turn_detection.interrupt_response, true, "barge-in any time");
assert.equal(cfg.session.audio.input.noise_reduction.type, "far_field");
assert.equal(cfg.session.audio.input.transcription.language, "en");

// One response.create per model response, however many tool calls it made; repeated events don't re-run a call.
{
	const c = new Calls();
	assert.equal(c.start("r1", "a"), true);
	assert.equal(c.start("r1", "b"), true);
	assert.equal(c.start("r1", "a"), false, "dup call event ignored");
	assert.equal(c.finish("r1", "a"), false);
	assert.equal(c.responseDone("r1"), false, "b still running");
	assert.equal(c.finish("r1", "b"), true, "last output in after done -> one continue");
	assert.equal(c.finish("r1", "b"), false, "never twice");
	assert.equal(c.responseDone("r1"), false);
	// Outputs all in before response.done: continue fires on done, once.
	c.start("r2", "x"); assert.equal(c.finish("r2", "x"), false); assert.equal(c.responseDone("r2"), true); assert.equal(c.responseDone("r2"), false);
	// Plain spoken response with no tools: no continue.
	assert.equal(c.responseDone("r3"), false);
	assert.equal(c.running, 0);
}

// The client never stops/mutes/re-acquires the mic outside stop() and the OS-ended path.
{
	const src = (await import("node:fs")).readFileSync(new URL("../web/src/lib/realtime.ts", import.meta.url), "utf8");
	const code = src.replace(/\/\/.*$/gm, "");
	assert.equal((code.match(/mediaDevices\.getUserMedia\(/g) ?? []).length, 1, "one getUserMedia call site");
	assert.equal((code.match(/this\.#getUserMedia\(\)/g) ?? []).length, 2, "called at start, and only again if the OS ends the track");
	assert.ok(!/\.enabled\s*=/.test(code), "never disables the track");
	assert.ok(!/audio\.muted\s*=\s*true/.test(code), "never mutes playback");
	assert.ok(!/\.pause\(\)/.test(code), "never pauses playback");
	assert.equal((code.match(/(?<!this)\.stop\(\)/g) ?? []).length, 1, "track.stop only in stop()");
	assert.ok(!/replaceTrack/.test(code.replace(/async #reacquire[\s\S]*?\n\t}\n/, "")), "replaceTrack only in the OS-ended path");
	assert.ok(/audioSession\.type = "play-and-record"/.test(code), "pins iOS audio session");
	assert.ok(!/response\.audio_transcript\.done/.test(code), "no beta alias (double transcript)");
}
assert.deepEqual(TOOLS.map((t) => t.name), ["ask_raubot", "raubot_wait", "raubot_status"]);
console.log("voice ok");
