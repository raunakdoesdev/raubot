import { BLOCK, CAP, CHIGH, CLOW, HIGH, JOBS, LOW, NODE, RETRY, TRIES } from "./prompts.ts";

export type Msg = { i: number; kind: "user" | "talk" | "tool" | "echo" | "job" | "devin"; text: string; date: number };
export type Part = [l: number, i: number];
export type Turn = { role: "user" | "assistant"; text: string };
/** One compaction call: the compaction view (as one text block, the cached prefix), the task turns; started() once the response begins. */
export type Llm = (chat: string, turns: Turn[], started: () => void) => Promise<string>;

const enc = new TextEncoder();
export const bytes = (s: string) => enc.encode(s).length;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export const cap = (s: string) =>
	s.length <= CAP ? s : `${s.slice(0, CAP / 2)}\n[... ${s.length - CAP} chars cut ...]\n${s.slice(-CAP / 2)}`;
export const UNBUILT = "(not summarized yet: zoom it)";
export const RULER = "-".repeat(NODE);

/**
 * OptChat merge order. For sibling lines (l, a) and (l, a+1) with T messages, due = (T - last) / 2^l, last being the pair's last message.
 * Code form (T + 1) / 2^l - a (same order, shifted by 2). Most due first; ties go to the oldest pair. Only pairs whose parent is built count.
 */
export const mostDue = (view: Part[], T: number, built: (l: number, i: number) => boolean) => {
	let best = -1, due = -Infinity, start = Infinity;
	for (let k = 0; k + 1 < view.length; k++) {
		const [l, a] = view[k], [m, b] = view[k + 1];
		if (l !== m || a % 2 !== 0 || b !== a + 1 || !built(l + 1, a >> 1)) continue;
		const d = (T + 1) / 2 ** l - a, s = a * 2 ** l;
		if (d > due || (d === due && s < start)) { due = d; best = k; start = s; }
	}
	return best;
};

/** A view with the OptChat sawtooth: appends grow it; past hi one batch merges the most due pairs down to lo (continuing at later appends if blocked). */
export class Sawtooth {
	view: Part[] = [];
	merging = false;
	hi: number; lo: number;
	size: (p: Part) => number;
	built: (l: number, i: number) => boolean;
	constructor(hi: number, lo: number, size: (p: Part) => number, built: (l: number, i: number) => boolean) {
		this.hi = hi; this.lo = lo; this.size = size; this.built = built;
	}
	total() { let s = 0; for (const p of this.view) s += this.size(p); return s; }
	/** First message not yet covered. */
	covered() { const p = this.view.at(-1); return p ? (p[1] + 1) << p[0] : 0; }
	/** Merges while in a batch; returns how many merges ran. */
	fold(T: number, force = false) {
		let total = this.total(), n = 0;
		if (total > this.hi || force) this.merging = true;
		while (this.merging && total > this.lo) {
			const k = mostDue(this.view, T, this.built);
			if (k < 0) break; // blocked by unbuilt parents: go on at the next message
			const [l, a] = this.view[k];
			total -= this.size(this.view[k]) + this.size(this.view[k + 1]);
			this.view.splice(k, 2, [l + 1, a >> 1]);
			total += this.size(this.view[k]);
			n++;
		}
		if (total <= this.lo) this.merging = false;
		return n;
	}
	push(i: number) { this.view.push([0, i]); return this.fold(i + 1); }
}

/** Memory: append-only log, binary summary tree, the chat view and the compaction view, both persisted (never rebuilt from the log). */
export class Memory {
	log: Msg[] = [];
	chat: Sawtooth;
	comp: Sawtooth;
	#nodes = new Map<string, string>();
	#sizes = new Map<string, number>();
	#ready = new Set<string>();
	#busy = new Set<string>();
	#retryAt = new Map<string, number>();
	#writing = new Map<string, Promise<void>>();
	#written = new Set<string>();
	#waiters: (() => void)[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;

	sql: SqlStorage;
	llm: Llm;
	changed: () => void;

	get view() { return this.chat.view; }

	constructor(sql: SqlStorage, llm: Llm, changed: () => void = () => {}) {
		this.sql = sql;
		this.llm = llm;
		this.changed = changed;
		sql.exec(`CREATE TABLE IF NOT EXISTS rb_msg (i INTEGER PRIMARY KEY, kind TEXT, text TEXT, date INTEGER);
			CREATE TABLE IF NOT EXISTS rb_node (l INTEGER, i INTEGER, text TEXT, PRIMARY KEY (l, i));
			CREATE TABLE IF NOT EXISTS rb_meta (k TEXT PRIMARY KEY, v TEXT)`);
		for (const r of sql.exec<Msg>("SELECT i, kind, text, date FROM rb_msg ORDER BY i")) this.log.push({ ...r });
		for (const r of sql.exec<{ l: number; i: number; text: string }>("SELECT l, i, text FROM rb_node"))
			this.#nodes.set(`${r.l}:${r.i}`, r.text);
		const size = (p: Part) => this.#size(p), built = (l: number, i: number) => this.#nodes.has(`${l}:${i}`);
		this.chat = new Sawtooth(HIGH, LOW, size, built);
		this.comp = new Sawtooth(CHIGH, CLOW, size, built);
		const saved = this.get("views");
		const s = saved ? (JSON.parse(saved) as { chat: Part[]; chatMerging: boolean; comp: Part[]; compMerging: boolean }) : undefined;
		if (s && covers(s.chat) <= this.log.length && covers(s.comp) === covers(s.chat)) {
			this.chat.view = s.chat; this.chat.merging = s.chatMerging;
			this.comp.view = s.comp; this.comp.merging = s.compMerging;
			for (let i = this.chat.covered(); i < this.log.length; i++) this.#push(i);
		} else {
			// One-time migration (no saved view): build it once with the OptChat algorithm, then keep it.
			for (let i = 0; i < this.log.length; i++) this.#push(i);
		}
		this.#save();
		// Seed the ready queue once; afterwards it's kept up to date, never rescanned.
		for (let i = 0; i < this.log.length; i++) if (!built(0, i)) this.#ready.add(`0:${i}`);
		for (const k of this.#nodes.keys()) this.#offer(k);
	}

	get(k: string) { return this.sql.exec<{ v: string }>("SELECT v FROM rb_meta WHERE k = ?", k).toArray()[0]?.v; }
	set(k: string, v: string) { this.sql.exec("INSERT OR REPLACE INTO rb_meta (k, v) VALUES (?, ?)", k, v); }
	#save() { this.set("views", JSON.stringify({ chat: this.chat.view, chatMerging: this.chat.merging, comp: this.comp.view, compMerging: this.comp.merging })); }

	append(kind: Msg["kind"], text: string, date: number) {
		const m: Msg = { i: this.log.length, kind, text: kind === "echo" || kind === "job" || kind === "devin" ? cap(text) : text, date };
		this.sql.exec("INSERT INTO rb_msg (i, kind, text, date) VALUES (?, ?, ?, ?)", m.i, m.kind, m.text, m.date);
		this.log.push(m);
		this.#ready.add(`0:${m.i}`);
		this.#push(m.i);
		this.#save();
		this.pump();
		this.changed();
	}

	/** Append message i to both views. When the chat view merges, the compaction view restarts from it, merged to its own low mark. */
	#push(i: number) {
		const merged = this.chat.push(i);
		if (merged > 0) {
			this.comp.view = this.chat.view.slice();
			this.comp.merging = false;
			this.comp.fold(i + 1, true);
		} else this.comp.push(i);
	}

	#size(p: Part) {
		const k = `${p[0]}:${p[1]}`;
		let s = this.#sizes.get(k);
		if (s === undefined) {
			const t = this.#nodes.get(k);
			s = bytes(this.line(p)) + 1;
			if (t !== undefined) this.#sizes.set(k, s);
			else s = Math.max(s, NODE + 16);
		}
		return s;
	}

	node(l: number, i: number) { return this.#nodes.get(`${l}:${i}`); }
	line([l, i]: Part) { return `${i << l}+${1 << l}|${(this.node(l, i) ?? UNBUILT).replace(/\n/g, " ")}`; }
	render() { return this.chat.view.map((p) => this.line(p)).join("\n"); }
	settled() { return this.chat.view.every(([l, i]) => this.node(l, i) !== undefined); }
	settle() { return this.settled() ? Promise.resolve() : new Promise<void>((r) => this.#waiters.push(r)); }

	zoom(id: number, n: number): string {
		const T = this.log.length;
		if (n < 1 || (n & (n - 1)) !== 0 || id % n !== 0 || id + n > T) return `error: ${id}+${n} is not a node`;
		if (n === 1) return `${this.log[id].kind}: ${this.log[id].text}`;
		const l = Math.log2(n) - 1;
		const kids: Part[] = [[l, (id / n) * 2], [l, (id / n) * 2 + 1]];
		return kids.map((p) => this.line(p)).join("\n");
	}
	date(id: number) { return this.log[id] ? new Date(this.log[id].date).toISOString() : `error: no message ${id}`; }

	/** Queue node k's parent once both halves are built. */
	#offer(k: string) {
		const [l, i] = k.split(":").map(Number);
		const sib = `${l}:${i ^ 1}`, parent = `${l + 1}:${i >> 1}`;
		if (this.#nodes.has(sib) && !this.#nodes.has(parent)) this.#ready.add(parent);
	}

	/** Unbuilt view lines before message i. */
	#unbuiltBefore(i: number) {
		let n = 0;
		for (const [l, a] of this.chat.view) { if (a << l >= i) break; if (this.node(l, a) === undefined) n++; }
		return n;
	}

	/** Start compactions from the ready queue: at most JOBS at once; a message once fewer than JOBS lines before it are unbuilt; a merge once both halves are built. */
	pump() {
		for (let progress = true; progress;) {
			progress = false;
			const now = Date.now();
			const cands = [...this.#ready].filter((k) => !this.#busy.has(k) && (this.#retryAt.get(k) ?? 0) <= now)
				.map((k) => k.split(":").map(Number) as Part)
				.sort((a, b) => ((a[1] + 1) << a[0]) - ((b[1] + 1) << b[0]) || a[0] - b[0]);
			for (const [l, i] of cands) {
				const key = `${l}:${i}`;
				if (l === 0 && this.#unbuiltBefore(i) >= JOBS) continue;
				const quick = this.#trivial(l, i);
				if (quick !== undefined) { this.#store(l, i, quick); progress = true; continue; }
				if (this.#busy.size >= JOBS) continue;
				this.#busy.add(key);
				this.#build(l, i)
					.then((text) => this.#store(l, i, text))
					.catch((e) => {
						console.error("compact", key, e);
						this.#retryAt.set(key, Date.now() + RETRY);
						clearTimeout(this.#timer);
						this.#timer = setTimeout(() => this.pump(), RETRY);
					})
					.finally(() => {
						this.#busy.delete(key);
						this.changed();
						this.pump();
					});
			}
		}
		if (this.settled()) for (const w of this.#waiters.splice(0)) w();
	}

	#store(l: number, i: number, text: string) {
		const key = `${l}:${i}`;
		this.#nodes.set(key, text);
		this.#sizes.delete(key);
		this.sql.exec("INSERT OR REPLACE INTO rb_node (l, i, text) VALUES (?, ?, ?)", l, i, text);
		this.#ready.delete(key);
		this.#retryAt.delete(key);
		if (((i + 1) << l) <= this.log.length) this.#offer(key);
	}

	pending() { return this.#busy.size > 0 || !this.settled(); }

	/** A node that needs no model call: a short message as is, or two short lines joined. */
	#trivial(l: number, i: number) {
		if (l === 0) { const m = this.log[i], t = oneLine(`${m.kind}: ${m.text}`); return bytes(t) <= NODE ? t : undefined; }
		const a = this.node(l - 1, 2 * i)!, b = this.node(l - 1, 2 * i + 1)!;
		return bytes(a) + 1 + bytes(b) <= NODE ? `${a}\n${b}` : undefined;
	}

	/** The compaction view for a node: its lines that end by the node's end (before the message, for a message), stopping at the first unbuilt one. */
	context(l: number, i: number) {
		const end = l === 0 ? i : (i + 1) << l;
		const out: string[] = [];
		for (const p of this.comp.view) {
			if ((p[1] + 1) << p[0] > end || this.node(...p) === undefined) break;
			out.push(this.line(p));
		}
		return out;
	}

	async #build(l: number, i: number): Promise<string> {
		let task: string;
		if (l === 0) {
			const m = this.log[i];
			task = `Compaction: compress message ${i} into one line of at most ${NODE} bytes\n(about 70 words), the length of this ruler:\n${RULER}\n<input>\n${m.kind}: ${m.text}\n</input>`;
		} else {
			const a = this.node(l - 1, 2 * i)!, b = this.node(l - 1, 2 * i + 1)!, n = 1 << (l - 1);
			const A = `${2 * i * n}+${n}`, B = `${(2 * i + 1) * n}+${n}`;
			task = `Compaction: merge lines ${A} and ${B}, adjacent, into one line of at most\n${NODE} bytes (about 70 words), the length of this ruler:\n${RULER}\n<chat> may hold their messages, ${i << l} to ${((i + 1) << l) - 1}, in more detail: take details\nof them from there too.\n<input>\n${oneLine(a)}\n${oneLine(b)}\n</input>`;
		}
		const lines = this.context(l, i);
		const chat = `<chat>\n${lines.join("\n")}\n</chat>\n\n`;
		// The cached prefix ends at the last whole block of BLOCK lines: one writer per prefix, the others wait for its response to start.
		const key = lines.slice(0, lines.length - (lines.length % BLOCK)).join("\n");
		const turns: Turn[] = [{ role: "user", text: task }];
		let best: string | undefined;
		for (let t = 0; t < TRIES; t++) {
			const out = oneLine(await this.#call(key, chat, turns));
			if (!out) continue;
			if (!best || bytes(out) < bytes(best)) best = out;
			if (bytes(out) <= NODE) return out;
			turns.push({ role: "assistant", text: out }, { role: "user", text: `Too long: your line is ${bytes(out)} bytes, over the ${NODE}-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${cutBytes(out, NODE)}| ← LIMIT` });
		}
		if (!best) throw new Error("compactor returned nothing");
		return best; // the shortest try; a few bytes over is fine, sizes are measured
	}

	async #call(key: string, chat: string, turns: Turn[]) {
		if (this.#written.has(key)) return this.llm(chat, turns, () => {});
		while (this.#writing.has(key)) await this.#writing.get(key);
		if (this.#written.has(key)) return this.llm(chat, turns, () => {});
		let open!: () => void;
		this.#writing.set(key, new Promise<void>((r) => (open = r)));
		const release = (ok: boolean) => {
			if (!this.#writing.has(key)) return;
			this.#writing.delete(key);
			if (ok) { this.#written.add(key); if (this.#written.size > 64) this.#written.delete(this.#written.values().next().value!); }
			open();
		};
		try { return await this.llm(chat, turns, () => release(true)); }
		finally { release(false); }
	}
}

const covers = (v: Part[]) => { const p = v.at(-1); return p ? (p[1] + 1) << p[0] : 0; };
function cutBytes(s: string, n: number) {
	let cut = "";
	for (const ch of s) if (bytes(cut + ch) <= n) cut += ch; else break;
	return cut;
}
