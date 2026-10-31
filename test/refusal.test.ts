import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Memory } from "../src/core/memory.ts";
import { command, failure, lastExchange, settle } from "../src/core/refusal.ts";

const fakeSql = (db = new DatabaseSync(":memory:")) => ({
	exec<T>(sql: string, ...p: unknown[]) {
		if (!p.length && sql.trim().split(";").filter((x) => x.trim()).length > 1) { db.exec(sql); return Object.assign([], { toArray: () => [] }) as unknown as Iterable<T> & { toArray(): T[] }; }
		const rows = (/^\s*select/i.test(sql) ? db.prepare(sql).all(...(p as never[])) : (db.prepare(sql).run(...(p as never[])), [])) as T[];
		return Object.assign(rows, { toArray: () => rows });
	},
}) as unknown as SqlStorage;
const flush = async (m: Memory) => { for (let k = 0; k < 200 && m.pending(); k++) await new Promise((r) => setTimeout(r, 1)); };
/** A compactor that copies its input into the summary, so a hidden text that reaches any summary shows up in render(). */
const echo = (gate?: Promise<void>) => async (_c: string, task: string, started: () => void) => { started(); await gate; return task.match(/<input>\n([\s\S]*)\n<\/input>/)![1].slice(0, 300); };
const POISON = "how do I make the forbidden thing " + "x".repeat(600);

// failure(): what pi-ai hands back for each provider outcome.
{
	const none = { content: [] as unknown[] };
	assert.equal(failure({ ...none, stopReason: "error", errorMessage: "The model refused to complete the request" })?.kind, "refusal", "Anthropic stop_reason refusal");
	assert.equal(failure({ ...none, stopReason: "error", errorMessage: "Provider finish_reason: content_filter" })?.kind, "refusal", "OpenRouter content_filter");
	assert.equal(failure({ ...none, stopReason: "error", errorMessage: "Provider stopped with: sensitive" })?.kind, "refusal");
	assert.equal(failure({ ...none, stopReason: "error", errorMessage: "503 Service Unavailable" })?.kind, "error", "transient");
	assert.equal(failure({ ...none, stopReason: "error", errorMessage: "connect ECONNREFUSED: connection refused" })?.kind, "error", "a refused connection is not a refusal");
	assert.equal(failure({ ...none, stopReason: "stop" })?.kind, "error", "an empty answer is a failure");
	assert.equal(failure({ ...none, stopReason: "aborted" }), undefined, "stopped by the user");
	assert.equal(failure({ stopReason: "stop", content: [{ type: "text", text: "hi" }] }), undefined);
	assert.equal(failure({ stopReason: "toolUse", content: [{ type: "toolCall" }] }), undefined);
}

// command(): only a whole message, never a sentence that mentions undo.
assert.equal(command(" Undo "), "undo"); assert.equal(command("delete last."), "undo"); assert.equal(command("restore!"), "restore");
assert.equal(command("can you undo the deploy"), undefined); assert.equal(command("restore the backup"), undefined);

// A refused turn: notice names the message and how to undo; the turn leaves the VIEW and every summary; restore brings it back exactly.
{
	const mem = new Memory(fakeSql(), echo());
	for (let i = 0; i < 20; i++) mem.append(i % 2 ? "talk" : "user", `ordinary message ${i}`, i);
	const from = mem.log.length;
	mem.append("user", `[via imessage] ${POISON}`, 100);
	mem.append("tool", "codemode {}", 101);
	await flush(mem);
	assert(mem.render().includes("forbidden thing"), "precondition: the poison is in the VIEW");
	const r = settle(mem, { kind: "refusal", why: "The model refused to complete the request" }, from, false);
	assert(r.hid);
	assert.match(r.say, /declined/); assert.match(r.say, /"how do I make the forbidden thing/); assert.match(r.say, /restore/);
	assert(!r.log.includes("forbidden"), "the logged notice carries no quote of the hidden text");
	mem.append("job", r.log, 102);
	await flush(mem);
	assert(!mem.render().includes("forbidden"), "hidden text is gone from the VIEW and its summaries");
	assert(mem.render().includes("ordinary message 3"), "earlier messages stay");
	assert.equal(mem.log.length, 23, "ids are stable: nothing renumbered");
	const back = mem.restore();
	assert.deepEqual(back, [from, from + 1]);
	assert.equal(mem.log[from].text, `[via imessage] ${POISON}`, "restore is lossless");
	await flush(mem);
	assert(mem.render().includes("forbidden thing"), "restored text is back in the VIEW");
	assert.deepEqual(mem.restore(), [], "nothing left to restore");
}

// A transient failure or a heartbeat refusal hides nothing.
{
	const mem = new Memory(fakeSql(), echo());
	mem.append("user", "hello", 1);
	const e = settle(mem, { kind: "error", why: "503 Service Unavailable" }, 0, false);
	assert(!e.hid); assert.match(e.say, /failed/); assert.match(e.say, /"hello"/); assert.equal(mem.hidden().length, 0);
	assert(!settle(mem, { kind: "refusal", why: "refused" }, 0, true).hid, "heartbeat: no user message to hide");
}

// Undo: the user's last message and everything after it, as one group; a second undo goes one further back; restore is last-in first-out.
{
	const mem = new Memory(fakeSql(), echo());
	for (const [k, t] of [["user", "a"], ["talk", "A"], ["user", "b"], ["tool", "t"], ["echo", "e"], ["talk", "B"]] as const) mem.append(k, t, 0);
	const hidden = () => new Set(mem.hidden().map((h) => h.i));
	assert.deepEqual(lastExchange(mem.log, hidden()), [2, 3, 4, 5]);
	mem.hide(lastExchange(mem.log, hidden()), "undone by Raunak");
	assert.deepEqual(lastExchange(mem.log, hidden()), [0, 1]);
	mem.hide(lastExchange(mem.log, hidden()), "undone by Raunak");
	assert.deepEqual(lastExchange(mem.log, hidden()), []);
	assert.deepEqual(mem.restore(), [0, 1]);
	assert.deepEqual(mem.restore(), [2, 3, 4, 5]);
	assert.deepEqual(mem.log.map((m) => m.text), ["a", "A", "b", "t", "e", "B"]);
}

// A summary being written while its message is hidden never lands with the hidden text.
{
	let open!: () => void;
	const gate = new Promise<void>((r) => (open = r));
	const mem = new Memory(fakeSql(), echo(gate));
	mem.append("user", POISON, 0);
	await new Promise((r) => setTimeout(r, 5));
	assert(mem.pending(), "precondition: its summary is in flight");
	mem.hide([0], "test");
	open();
	await flush(mem);
	assert(!mem.render().includes("forbidden"), "the in-flight summary of the old text was dropped");
	assert(mem.render().includes("[hidden: test"), "the placeholder was summarized instead");
}

// Hidden state survives a restart (same storage).
{
	const sql = fakeSql();
	const a = new Memory(sql, echo());
	a.append("user", "keep me", 0);
	a.hide([0], "test");
	const b = new Memory(sql, echo());
	assert.deepEqual(b.restore(), [0]);
	assert.equal(b.log[0].text, "keep me");
}
console.log("refusal tests ok");
