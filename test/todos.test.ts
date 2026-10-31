import assert from "node:assert/strict";
import { apply, parseFields, PROMPT, TOOL_DOC, type Todo } from "../src/core/todos.ts";

const now = "2026-10-22T10:00:00.000Z";
const t: Todo = { id: "a", title: "x", state: "suggested", source: "raubot", order: 1, created_at: now, updated_at: now };
const w = apply(t, { state: "working" }, now);
assert.equal(w.state, "working");
const d = apply(w, { state: "done" }, now);
assert.equal(d.state, "done"); assert.equal(d.done_at, now);
assert.equal(apply(d, { state: "later" }, now).done_at, undefined);
assert.equal(apply(t, { state: "dismissed" }, now).state, "dismissed");
assert.equal(apply({ ...t, detail: "y" }, parseFields({ detail: null }), now).detail, undefined);
assert.equal("looks_done" in parseFields({ looks_done: true }), false, "looks_done is gone");
assert.throws(() => parseFields({ state: "in_progress" }), /state: one of/);
assert.throws(() => parseFields({ priority: 9 }), /priority/);
assert.equal(parseFields({ due_at: "2026-10-23T09:00:00-07:00" }).due_at, "2026-10-23T16:00:00.000Z");
for (const s of [PROMPT, TOOL_DOC]) { assert.doesNotMatch(s, /looks_done|morning brief|only he|only Raunak/i); }
assert.match(PROMPT, /live brief/);
console.log("todos ok");
