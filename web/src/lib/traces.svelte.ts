// Client side of live traces: runs keyed by id (streamed over the socket or polled), matched to transcript tool rows by code hash.
export type CallStatus = "running" | "ok" | "failed";
export type Call = { id: number; name: string; arg: string; status: CallStatus; start: number; ms?: number; out?: string };
/** `calls` is the count; `list` the loaded call summaries; `full` once `list` is complete. `scope`: "main" or "agent:<id>". */
export type Run = { run: string; conv: string; hash: string; status: CallStatus; start: number; ms?: number; calls: number; failed: number; job?: number; list?: Call[]; full?: boolean; scope?: string };
export type Body = { args: string; out?: string };

/** Same as the server: 32-bit FNV-1a of the code's first 200 UTF-16 units. */
export const fnv = (s: string) => {
	s = s.slice(0, 200);
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return (h >>> 0).toString(16).padStart(8, "0");
};

/** Decodes a JSON string body that may be cut off mid-way. */
const unjson = (s: string) => {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '"') break;
		if (c !== "\\") { out += c; continue; }
		const n = s[++i];
		if (n === undefined) break;
		if (n === "u") { const h = s.slice(i + 1, i + 5); if (h.length < 4) break; out += String.fromCharCode(parseInt(h, 16)); i += 4; }
		else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[n] ?? n;
	}
	return out;
};

/** A transcript tool line ("codemode {json}") as a row: the script's code, a one-line summary, its hash. */
export const parseTool = (text: string) => {
	const name = text.split(/[\s:]/)[0], rest = text.slice(name.length + 1);
	if (name !== "codemode") return { name, arg: rest.replace(/\s+/g, " ").slice(0, 160) };
	const at = rest.indexOf('"code":"');
	const code = at >= 0 ? unjson(rest.slice(at + 8)) : "";
	const bg = /"background":\{"label":"((?:[^"\\]|\\.)*)"/.exec(rest)?.[1];
	return { name, code, hash: code ? fnv(code) : undefined, arg: (bg ? `[bg] ${unjson(bg)} · ` : "") + summary(code) };
};

/** First meaningful line of a script. */
export const summary = (code: string) => (code.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("// @options")) ?? "").slice(0, 160);

export const dur = (ms?: number) => ms === undefined ? "" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

class Traces {
	runs = $state<Record<string, Run>>({});
	bodies = $state<Record<string, Body | "loading" | string>>({});
	#ix = new Map<string, Map<number, number>>();

	/** Run headers from /traces.json. */
	merge(list: Run[], scope: string) {
		for (const r of list) {
			const x = this.runs[r.run];
			if (x) { if (x.status === "running" || r.status !== "running") Object.assign(x, { status: r.status, ms: r.ms, calls: r.calls, failed: r.failed }); }
			else this.runs[r.run] = { ...r, scope, full: false };
		}
	}

	/** A streamed delta: the run's header plus changed calls. */
	apply(e: { run: Run; calls?: Call[] }, scope = "main") {
		let r = this.runs[e.run.run];
		if (!r) { this.runs[e.run.run] = { ...e.run, scope, list: [], full: e.run.calls === 0 }; r = this.runs[e.run.run]; }
		else Object.assign(r, { status: e.run.status, ms: e.run.ms, calls: e.run.calls, failed: e.run.failed });
		if (e.calls?.length) this.#put(r, e.calls, true);
	}

	#put(r: Run, calls: Call[], newer: boolean) {
		r.list ??= [];
		let ix = this.#ix.get(r.run);
		if (!ix) this.#ix.set(r.run, (ix = new Map(r.list.map((c, k) => [c.id, k]))));
		for (const c of calls) {
			const k = ix.get(c.id);
			if (k === undefined) { ix.set(c.id, r.list.length); r.list.push(c); continue; }
			const old = r.list[k];
			if (!newer && old.status !== "running" && c.status === "running") continue; // a fetch older than a streamed update
			if (old.status !== c.status) delete this.bodies[`${r.run}:${c.id}`];
			r.list[k] = c;
		}
	}

	/** Loads a run's complete call list (call from an event handler or effect, not during render). */
	async load(id: string, force = false) {
		const r = this.runs[id];
		if (!r || (r.full && !force)) return;
		const res = await fetch(`/trace.json?run=${encodeURIComponent(id)}`);
		if (!res.ok) return;
		const d = (await res.json()) as { run: Run; calls: Call[] };
		Object.assign(r, { status: d.run.status, ms: d.run.ms, calls: d.run.calls, failed: d.run.failed });
		this.#put(r, d.calls, false);
		r.full = true;
	}

	/** Loads one call's full args/result into `bodies`. */
	async loadBody(run: string, id: number) {
		const k = `${run}:${id}`;
		if (this.bodies[k] && this.bodies[k] !== "error") return;
		this.bodies[k] = "loading";
		const res = await fetch(`/trace.json?run=${encodeURIComponent(run)}&call=${id}`).catch(() => undefined);
		this.bodies[k] = res?.ok ? ((await res.json()) as Body) : "error";
	}

	byJob(job: number) { return Object.values(this.runs).find((r) => r.job === job); }

	/** Main chat: pairs each tool row (hash, logged at `date`) with the first unused run of that hash that started after it. */
	match(rows: { key: number; hash: string; date: number }[], scope: string) {
		const by = new Map<string, Run[]>();
		for (const r of Object.values(this.runs)) if (r.scope === scope) (by.get(r.hash) ?? by.set(r.hash, []).get(r.hash)!).push(r);
		for (const l of by.values()) l.sort((a, b) => a.start - b.start);
		const out = new Map<number, Run>(), used = new Set<string>();
		for (const row of [...rows].sort((a, b) => a.date - b.date)) {
			const r = by.get(row.hash)?.find((x) => !used.has(x.run) && x.start >= row.date - 15_000);
			if (r) { used.add(r.run); out.set(row.key, r); }
		}
		return out;
	}

	/** Subagent view (no dates): pairs rows and runs of the same hash from the newest back. */
	matchTail(rows: { key: number; hash: string }[], scope: string) {
		const by = new Map<string, Run[]>();
		for (const r of Object.values(this.runs)) if (r.scope === scope) (by.get(r.hash) ?? by.set(r.hash, []).get(r.hash)!).push(r);
		for (const l of by.values()) l.sort((a, b) => b.start - a.start);
		const out = new Map<number, Run>(), seen = new Map<string, number>();
		for (const row of [...rows].reverse()) {
			const n = seen.get(row.hash) ?? 0;
			seen.set(row.hash, n + 1);
			const r = by.get(row.hash)?.[n];
			if (r) out.set(row.key, r);
		}
		return out;
	}
}

export const traces = new Traces();
