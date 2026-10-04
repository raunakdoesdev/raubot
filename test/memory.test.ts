import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { Memory } from "../src/memory.ts";
import { VIEW } from "../src/prompts.ts";

const db = new DatabaseSync(":memory:");
const sql = {
	exec(q: string, ...p: unknown[]) {
		const rows = /^\s*select/i.test(q) ? db.prepare(q).all(...(p as never[])) : (p.length ? db.prepare(q).run(...(p as never[])) : db.exec(q), []);
		return Object.assign(rows, { toArray: () => rows });
	},
} as unknown as SqlStorage;

let calls = 0;
const mem = new Memory(sql, async () => { calls++; return "s".repeat(400); });
for (let i = 0; i < 3000; i++) mem.append(i % 2 ? "talk" : "user", `message ${i} `.repeat(i % 7 === 0 ? 80 : 20), Date.now());
await mem.settle();
while (mem.pending()) await new Promise((r) => setTimeout(r, 5));

const view = mem.render();
assert.ok(new TextEncoder().encode(view).length <= VIEW, "view bounded");
let next = 0;
for (const [l, i] of mem.view) { assert.equal(i << l, next, "contiguous"); next += 1 << l; }
assert.equal(next, 3000, "covers log");
assert.match(mem.zoom(0, 1), /^user: message 0/);
assert.equal(mem.zoom(3, 2).startsWith("error"), true);
const re = new Memory(sql, async () => { throw new Error("no calls on reload"); });
assert.ok(re.settled(), "reload needs no new summaries");
assert.ok(new TextEncoder().encode(re.render()).length <= VIEW, "reloaded view bounded");
console.log(`ok: ${mem.view.length} lines, ${view.length} bytes, ${calls} compactor calls`);
