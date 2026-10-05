// Live traces of codemode scripts: each run and the nested tool calls inside it, for the web UI.
// Summaries stream to clients; full args/results are fetched on expand. Recent runs live in memory; finished runs persist (capped) in storage.
import type { Hooks } from "./codemode.ts";

export type CallStatus = "running" | "ok" | "failed";
/** One nested call, as streamed: short summaries only. */
export type TraceCall = { id: number; name: string; arg: string; status: CallStatus; start: number; ms?: number; out?: string };
/** One script run. `conv` is the conversation that ran it (raubot's root or a subagent, by id) or "job:<id>". `hash` keys it to the transcript's tool line: fnv1a of the code's first 200 chars (long tool lines may reach the app cut). */
export type TraceRun = { run: string; conv: string; hash: string; status: CallStatus; start: number; ms?: number; calls: number; failed: number; job?: number };
/** Streamed delta: a run's header and the calls that changed since the last delta. */
export type TraceEvent = { run: TraceRun; calls?: TraceCall[] };
type Body = { args: string; out?: string };
type Live = { head: TraceRun; calls: TraceCall[]; bodies: Map<number, Body>; dirty: Set<number>; timer?: ReturnType<typeof setTimeout> };

const MAX_CALLS = 500, KEEP_BODIES = 150, MEM_RUNS = 40, INDEX = 400, SUM = 140, BODY = 20_000, STORED_BODY = 3000;

/** 32-bit FNV-1a over UTF-16 code units, hex; the web app computes the same. */
export const fnv = (s: string) => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return (h >>> 0).toString(16).padStart(8, "0");
};

const one = (s: string, n = SUM) => { const x = s.replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n… (" + (s.length - n) + " more chars)" : s);
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 1));
/** Profile ids and other uuids make app paths unreadable; keep the meaningful segments. */
const appName = (path: string[]) => path.filter((k) => k !== "profiles" && !/^ins_|^[0-9a-f]{8}-/.test(k)).join(".");

/** A one-line summary of a call's args, per tool. */
const argSummary = (name: string, args: unknown) => {
	const a = (args ?? {}) as Record<string, unknown>;
	if (name === "bash" && typeof a.cmd === "string") return one(a.cmd);
	if (name === "zoom") return "#" + a.id + "+" + a.n;
	if (name === "agent" && typeof a.task === "string") return (a.computer ? "[computer] " : "") + one(a.task);
	if (name === "decide") return Object.keys((a.questions as object) ?? {}).join(", ") + " · " + one(str(a.state), 80);
	if (name === "search" && typeof a.query === "string") return one(a.query);
	const j = str(args);
	return one(j === "{}" ? "" : j);
};

export class Tracer {
	#mem = new Map<string, Live>();
	#index: TraceRun[] = [];
	#ready: Promise<void>;
	#storage: DurableObjectStorage;
	#emit: (e: TraceEvent) => void;
	constructor(storage: DurableObjectStorage, emit: (e: TraceEvent) => void) {
		this.#storage = storage; this.#emit = emit;
		this.#ready = storage.get<TraceRun[]>("trace:index").then((x) => void (this.#index = x ?? []), () => {});
	}

	/** Starts tracing a run: hooks for codemode, and `end` once it finishes. Never throws into the caller. */
	begin(conv: string, code: string, job?: number): { hooks: Hooks; end(error: boolean): void } {
		const head: TraceRun = { run: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), conv, hash: fnv(code.slice(0, 200)), status: "running", start: Date.now(), calls: 0, failed: 0, ...(job !== undefined && { job }) };
		const live: Live = { head, calls: [], bodies: new Map(), dirty: new Set() };
		this.#mem.set(head.run, live);
		this.#trim();
		this.#emit({ run: { ...head }, calls: [] });
		const flush = () => {
			if (live.timer) clearTimeout(live.timer);
			live.timer = undefined;
			const calls = [...live.dirty].map((i) => live.calls[i]).filter(Boolean).map((c) => ({ ...c }));
			live.dirty.clear();
			this.#emit({ run: { ...head }, calls });
		};
		// Deltas are batched per run (150ms), so a script fanning out hundreds of calls sends a few messages, not hundreds.
		const touch = (i: number) => { live.dirty.add(i); live.timer ??= setTimeout(flush, 150); };
		const byId = new Map<number, number>();
		const hooks: Hooks = {
			call: (id, name, args) => {
				if (byId.has(id)) return; // re-issued after a thaw
				let n = name, a = args;
				if (name === "__app") { const x = args as { path: string[]; args: unknown }; n = appName(x.path); a = x.args; }
				head.calls++;
				if (live.calls.length >= MAX_CALLS) return;
				const c: TraceCall = { id, name: n, arg: argSummary(n, a), status: "running", start: Date.now() };
				const i = live.calls.push(c) - 1;
				byId.set(id, i);
				live.bodies.set(id, { args: cut(str(a), BODY) });
				touch(i);
			},
			settle: (id, ok, payload) => {
				const i = byId.get(id);
				const c = i === undefined ? undefined : live.calls[i];
				if (!c || c.status !== "running") return;
				let out = payload;
				if (ok) { try { out = str(JSON.parse(payload)); } catch {} }
				c.status = ok ? "ok" : "failed"; c.ms = Date.now() - c.start; c.out = one(out);
				if (!ok) head.failed++;
				const b = live.bodies.get(id); if (b) b.out = cut(out, BODY);
				touch(i!);
			},
		};
		let ended = false;
		return {
			hooks,
			end: (error) => {
				if (ended) return;
				ended = true;
				head.status = error ? "failed" : "ok"; head.ms = Date.now() - head.start;
				live.calls.forEach((c, i) => { if (c.status === "running") { c.status = "failed"; c.ms = Date.now() - c.start; c.out = "(never settled)"; live.dirty.add(i); } });
				flush();
				void this.#persist(live).catch((e) => console.error("trace persist", e));
			},
		};
	}

	#trim() {
		for (const [k, v] of this.#mem) {
			if (this.#mem.size <= MEM_RUNS) break;
			if (v.head.status !== "running") this.#mem.delete(k);
		}
	}

	async #persist(live: Live) {
		await this.#ready;
		const { head } = live;
		const bodies: Record<number, Body> = {};
		for (const c of live.calls.slice(0, KEEP_BODIES)) {
			const b = live.bodies.get(c.id);
			if (b) bodies[c.id] = { args: cut(b.args, STORED_BODY), ...(b.out !== undefined && { out: cut(b.out, STORED_BODY) }) };
		}
		this.#index.push({ ...head });
		const drop = this.#index.length > INDEX ? this.#index.splice(0, this.#index.length - INDEX) : [];
		await this.#storage.put({ ["trace:r:" + head.run]: { head, calls: live.calls }, ["trace:b:" + head.run]: bodies, "trace:index": this.#index });
		if (drop.length) await this.#storage.delete(drop.flatMap((r) => ["trace:r:" + r.run, "trace:b:" + r.run]));
	}

	/** Recent runs, oldest first, optionally only those whose conv passes `ok`. */
	async runs(ok: (conv: string) => boolean = () => true, limit = 100) {
		await this.#ready;
		const seen = new Set<string>(), out: TraceRun[] = [];
		for (const r of this.#index) if (ok(r.conv)) { out.push(r); seen.add(r.run); }
		for (const l of this.#mem.values()) if (!seen.has(l.head.run) && ok(l.head.conv)) out.push({ ...l.head });
		return out.sort((a, b) => a.start - b.start).slice(-limit);
	}

	/** A run's header and call summaries. */
	async get(run: string): Promise<{ run: TraceRun; calls: TraceCall[] } | undefined> {
		const l = this.#mem.get(run);
		if (l) return { run: { ...l.head }, calls: l.calls.map((c) => ({ ...c })) };
		const s = await this.#storage.get<{ head: TraceRun; calls: TraceCall[] }>("trace:r:" + run);
		return s && { run: s.head, calls: s.calls };
	}

	/** One call's full args and result (truncated). */
	async body(run: string, id: number): Promise<Body | undefined> {
		const l = this.#mem.get(run);
		if (l) return l.bodies.get(id);
		return (await this.#storage.get<Record<number, Body>>("trace:b:" + run))?.[id];
	}
}
