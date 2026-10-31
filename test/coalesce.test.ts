import { Coalescer, joinParts } from "../src/core/channels/coalesce.ts";
import assert from "node:assert/strict";

// Fake clock and timers.
let t = 0;
const timers = new Map<number, { at: number; fn: () => void }>();
let nid = 0;
const setTimer = (fn: () => void, ms: number) => { const id = ++nid; timers.set(id, { at: t + ms, fn }); return id; };
const clearTimer = (id: unknown) => void timers.delete(id as number);
const advance = async (ms: number) => {
	const end = t + ms;
	for (;;) {
		const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
		if (!next) break;
		t = next[1].at; timers.delete(next[0]); next[1].fn();
		await new Promise((r) => setTimeout(r, 0));
	}
	t = end;
	await new Promise((r) => setTimeout(r, 0));
};

const out: [string, string[]][] = [];
const c = new Coalescer<string>({ gap: 8000, max: 30000, flush: (k, p) => void out.push([k, p]), now: () => t, setTimer, clearTimer });

// Three parts a second apart: one message, in order, even if the first part (a download) resolves last.
let slow!: (v: string) => void;
c.add("imessage:A", new Promise<string>((r) => (slow = r)));
await advance(1000); c.add("imessage:A", "two");
await advance(1000); c.add("imessage:A", "three");
await advance(7999);
assert.equal(out.length, 0);
await advance(1);
assert.equal(out.length, 0); // waits for the slow part
slow("one"); await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(out.shift(), ["imessage:A", ["one", "two", "three"]]);

// A single text goes out after the gap.
c.add("imessage:A", "hi"); await advance(8000);
assert.deepEqual(out.shift(), ["imessage:A", ["hi"]]);

// Different conversations never merge.
c.add("imessage:A", "a"); c.add("imessage:B", "b"); await advance(8000);
assert.deepEqual(out.splice(0).sort(), [["imessage:A", ["a"]], ["imessage:B", ["b"]]]);

// A gap longer than the window splits messages.
c.add("imessage:A", "x"); await advance(9000); c.add("imessage:A", "y"); await advance(8000);
assert.deepEqual(out.splice(0), [["imessage:A", ["x"]], ["imessage:A", ["y"]]]);

// A steady trickle is capped at max from the first part.
for (let i = 0; i < 10; i++) { c.add("imessage:A", String(i)); await advance(5000); }
assert.ok(out.length >= 1);
assert.deepEqual(out[0], ["imessage:A", ["0", "1", "2", "3", "4", "5"]]);
await advance(30000);
assert.equal(out.flat(2).filter((x) => /^\d$/.test(x)).length, 10);
assert.equal(c.pending(), 0);

// Joining keeps each part's attachments after its text.
assert.equal(joinParts([{ text: "https://slack.com/x", files: [] }, { text: "do this", files: ["uploads/a.png"] }, { text: "", files: ["uploads/b.pdf"] }]),
	"https://slack.com/x\ndo this\n[attached: uploads/a.png]\n[attached: uploads/b.pdf]");
console.log("coalesce ok");
