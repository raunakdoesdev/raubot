import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Memory, mostDue, Sawtooth, bytes, type Part, type Turn } from "../src/core/memory.ts";
import { pieces } from "../src/core/pieces.ts";
import { BLOCK, HIGH, LOW, NODE } from "../src/core/prompts.ts";

// --- 1. Merge order = Taelin's binary push, with the push-sized budget (t = 0..N, N = 20000 by default) ---
type St = { keep: number; state: number; older: St | null } | null;
const push = (s: number, st: St): St => {
	if (st === null) return { keep: 0, state: s, older: null };
	if (st.keep === 0) return { keep: 1, state: st.state, older: st.older };
	return { keep: 0, state: s, older: push(st.state, st.older) };
};
const toView = (st: St, T: number): Part[] => {
	const xs: number[] = [];
	for (let s = st; s; s = s.older) xs.push(s.state);
	xs.reverse();
	return xs.map((a, k) => { const n = (xs[k + 1] ?? T) - a; const l = Math.log2(n); assert(Number.isInteger(l) && a % n === 0); return [l, a / n] as Part; });
};
const N = Number(process.env.N ?? 20_000);
{
	const sw = new Sawtooth(0, 0, () => 1, () => true);
	let st: St = null, match = 0;
	for (let t = 0; t <= N; t++) {
		st = push(t, st);
		const want = toView(st, t + 1);
		sw.hi = sw.lo = want.length;
		sw.push(t);
		if (JSON.stringify(sw.view) === JSON.stringify(want)) match++;
	}
	assert.equal(match, N + 1, `last-message due matches push at ${match}/${N + 1}`);
	// The old rule (from the first message) diverges, as the spec says (481/20001).
	const old = (v: Part[], T: number) => { let b = -1, d = -1; for (let k = 0; k + 1 < v.length; k++) { const [l, a] = v[k], [m, c] = v[k + 1]; if (l !== m || a % 2 || c !== a + 1) continue; const x = (T - (a << l)) / 2 ** (l + 2); if (x > d) { d = x; b = k; } } return b; };
	const v: Part[] = []; let om = 0; st = null;
	for (let t = 0; t <= N; t++) {
		st = push(t, st); const want = toView(st, t + 1); v.push([0, t]);
		while (v.length > want.length) { const k = old(v, t + 1); if (k < 0) break; const [l, a] = v[k]; v.splice(k, 2, [l + 1, a >> 1]); }
		if (JSON.stringify(v) === JSON.stringify(want)) om++;
	}
	assert(N < 5000 || om < N / 4, `old rule should mostly differ, matched ${om}`);
	console.log(`push check: new rule ${match}/${N + 1}, old (first-message) rule ${om}/${N + 1}`);
	// spec's T=10 example: view 0+4, 4+4, 8+1, 9+1 -> merge 8-9
	assert.equal(mostDue([[2, 0], [2, 1], [0, 8], [0, 9]], 10, () => true), 2);
	// unbuilt parents are skipped
	assert.equal(mostDue([[0, 0], [0, 1], [0, 2], [0, 3]], 4, (l, i) => !(l === 1 && i === 1)), 0);
}

// --- 2. Memory over a fake DO SQL: batches, prefixes, persistence, migration ---
const fakeSql = (db = new DatabaseSync(":memory:")) => ({
	exec<T>(sql: string, ...p: unknown[]) {
		if (!p.length && sql.trim().split(";").filter((x) => x.trim()).length > 1) { db.exec(sql); return Object.assign([], { toArray: () => [] }) as unknown as Iterable<T> & { toArray(): T[] }; }
		const rows = (/^\s*select/i.test(sql) ? db.prepare(sql).all(...(p as never[])) : (db.prepare(sql).run(...(p as never[])), [])) as T[];
		return Object.assign(rows, { toArray: () => rows });
	},
}) as unknown as SqlStorage;
const rnd = (s: number) => () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const r = rnd(7);
let calls = 0, retries = 0;
const llm = async (_chat: string, turns: Turn[], started: () => void) => {
	calls++; started();
	const long = turns.length === 1 && r() < 0.1; if (turns.length > 1) retries++;
	return "s".repeat(long ? 600 : 380 + Math.floor(r() * 130));
};
const flush = async (m: Memory) => { for (let k = 0; k < 50 && m.pending(); k++) await new Promise((res) => setImmediate(res)); };
const sql = fakeSql();
const mem = new Memory(sql, llm);
const M = Number(process.env.M ?? 1500);
let prev = "", prevParts: Part[] = [], batches = 0, maxBytes = 0, minAfter = Infinity;
for (let i = 0; i < M; i++) {
	mem.append("echo", "x".repeat(r() < 0.3 ? 40 : 600 + Math.floor(r() * 2000)), Date.now());
	await flush(mem);
	assert(mem.settled(), `settled after ${i}`);
	const view = mem.render(), parts = mem.view.slice();
	const grew = prevParts.length <= parts.length && prevParts.every((p, k) => p[0] === parts[k][0] && p[1] === parts[k][1]);
	if (grew) assert(view.startsWith(prev), `view ${i - 1} is a prefix of view ${i}`);
	else { batches++; minAfter = Math.min(minAfter, bytes(view)); assert(bytes(view) <= LOW + 600, `batch lands at <= LOW (${bytes(view)})`); }
	maxBytes = Math.max(maxBytes, bytes(view));
	prev = view; prevParts = parts;
}
assert(maxBytes <= HIGH + NODE + 32, `view stays <= HIGH (${maxBytes})`);
assert(M < 1000 || batches >= 3, `batches: ${batches}`);
const cbytes = mem.comp.view.reduce((s, p) => s + bytes(mem.line(p)) + 1, 0);
assert(cbytes <= 32_000 + NODE + 32, `comp view ${cbytes}`);
let at = 0; for (const [l, i] of mem.view) { assert.equal(i << l, at); at += 1 << l; } assert.equal(at, M);
console.log(`memory: ${M} msgs, ${batches} batches (prefix-stable between them), view max ${maxBytes} B, min after batch ${minAfter} B, ${mem.view.length} lines, comp view ${cbytes} B, ${calls} llm calls, ${retries} "Too long" retries`);
const again = new Memory(sql, llm);
assert.equal(again.render(), mem.render(), "restart keeps the view byte-identical");
sql.exec("DELETE FROM rb_meta WHERE k = 'views'");
const mig = new Memory(sql, llm);
assert(mig.get("views"), "migration saves the view");
let a2 = 0; for (const [l, i] of mig.view) { assert.equal(i << l, a2); a2 += 1 << l; } assert.equal(a2, M);
assert(bytes(mig.render()) <= HIGH + NODE, "migrated view within budget");
assert.equal(new Memory(sql, llm).render(), mig.render(), "migrated view persists");
assert.equal((sql.exec("SELECT count(*) AS n FROM rb_msg") as unknown as { n: number }[])[0].n, M, "no log loss");

// --- 3. Cache-read share estimate (model of Anthropic's cache: entries at marks, 20-block lookback, 0.1x read) ---
// Each call: [system+tools 30 KB] [view blocks] [new message ~1 KB]. Marks: system end, last whole view block, request end.
const cacheSim = () => {
	const store = new Set<string>(); let read = 0, total = 0;
	const memo = new Map<string, number>(); // block text -> id (so prefix keys are short)
	const id = (x: string) => memo.get(x) ?? (memo.set(x, memo.size), memo.size - 1);
	return {
		call(blocks: string[]) {
			const all = ["SYS".padEnd(30_000, "."), ...blocks];
			const keys: string[] = [], len: number[] = []; let k = "", b = 0;
			for (const x of all) { k += id(x) + ","; b += x.length; keys.push(k); len.push(b); }
			const marks = [0, all.length - 1];
			let best = 0;
			for (const m of marks) for (let j = m; j >= Math.max(0, m - 20); j--) if (store.has(keys[j])) { best = Math.max(best, len[j]); break; }
			read += best; total += b + 1000;
			for (const m of marks) store.add(keys[m]);
		},
		share: () => read / total,
	};
};
{
	const text = (l: number, i: number) => "n".repeat(380 + ((l * 7919 + i * 104729) % 130)) + `${l}.${i}`;
	const line = ([l, i]: Part) => `${i << l}+${1 << l}|${text(l, i)}`;
	const size = (p: Part) => 380 + ((p[0] * 7919 + p[1] * 104729) % 130) + `${p[0]}.${p[1]}${p[1] << p[0]}+${1 << p[0]}|`.length + 1;
	const sw = new Sawtooth(HIGH, LOW, size, () => true);
	const ns = cacheSim(), os = cacheSim();
	let v: Part[] = [], tot = 0;
	const T2 = Number(process.env.T2 ?? 4000), WARM = 1000;
	for (let t = 0; t < T2; t++) {
		sw.push(t);
		// old algorithm: merge at every message down to 128 KB, first-message rule, marks at 50k/80k/100k chars
		v.push([0, t]); tot += size([0, t]);
		while (tot > HIGH) { let b = -1, d = -1; for (let k = 0; k + 1 < v.length; k++) { const [l, a] = v[k], [m, c] = v[k + 1]; if (l !== m || a % 2 || c !== a + 1) continue; const x = (t + 1 - (a << l)) / 2 ** (l + 2); if (x > d) { d = x; b = k; } } if (b < 0) break; const [l, a] = v[b]; tot -= size(v[b]) + size(v[b + 1]); v.splice(b, 2, [l + 1, a >> 1]); tot += size(v[b]); }
		if (t < WARM) continue;
		const np = pieces(sw.view.map(line).join("\n"));
		ns.call(np.out.slice(0, np.mark + 1));
		const s = v.map(line).join("\n"); const out: string[] = []; let at = 0;
		for (const mk of [50_000, 80_000, 100_000]) { if (mk >= s.length) break; const cut = s.lastIndexOf("\n", mk) + 1; if (cut > at) out.push(s.slice(at, (at = cut))); }
		os.call(out);
	}
	const n = ns.share(), o = os.share();
	console.log(`cache-read share (one turn per message, ${T2 - WARM} turns, 30 KB system+tools, 1 KB message): new ${(n * 100).toFixed(1)}%, old ${(o * 100).toFixed(1)}%`);
	assert(n > 0.9, `new cache share ${n}`);
	assert(n > o);
}// pieces: blocks of BLOCK lines, mark on the last whole one
{
	const v = Array.from({ length: 10 }, (_, k) => `${k}+1|x`).join("\n");
	const { out, mark } = pieces(v);
	assert.equal(out.join(""), `<view>\n${v}\n</view>\n\nNew message:\n`);
	assert.equal(mark, 1); assert.equal(out.length, 3); assert.equal(out[0].split("\n").length - 1, 1 + BLOCK);
	const e8 = Array.from({ length: 8 }, (_, k) => `${k}+1|x`).join("\n");
	assert.equal(pieces(e8).out.join(""), `<view>\n${e8}\n</view>\n\nNew message:\n`);
	assert.equal(pieces("").out.join(""), "<view>\n\n</view>\n\nNew message:\n");
	assert.equal(pieces("").mark, -1);
}
console.log("memory tests ok");
