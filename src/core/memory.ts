import { BLOCK, CAP, CHIGH, CLOW, HIGH, JOBS, LOW, NODE, RETRY, TRIES } from "./prompts.ts";

export type Msg = { i: number; kind: "user" | "talk" | "tool" | "echo" | "job" | "devin"; text: string; date: number };
export type Part = [l: number, i: number];
/** A hidden message's original, by group: one undo or one quarantined turn. */
export type Hidden = { g: number; i: number; kind: Msg["kind"]; text: string; why: string; date: number };
/** One compaction call: the compaction view (as one text block, the cached prefix), the task; started() once the response begins. "" = the model answered with no line (a refusal); a throw = the call failed, try later. */
export type Llm = (chat: string, task: string, started: () => void) => Promise<string>;
export type Image = { mimeType: string; data: string };

const enc = new TextEncoder();
export const bytes = (s: string) => enc.encode(s).length;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export const cap = (s: string) =>
	s.length <= CAP ? s : `${s.slice(0, CAP / 2)}\n[... ${s.length - CAP} chars cut ...]\n${s.slice(-CAP / 2)}`;
/** Where a page of a long text from `at` ends: CAP chars on, after its last newline if it has one (Unii Clip.ts). */
const pageEnd = (s: string, at: number) => {
	if (s.length - at <= CAP) return s.length;
	const nl = s.lastIndexOf("\n", at + CAP - 1);
	const low = s.charCodeAt(at + CAP) >> 10 === 0x37;
	return nl >= at ? nl + 1 : at + CAP - (low ? 1 : 0);
};
/** A long text's page from `at`, saying where to go on. */
export const page = (s: string, at = 0) => {
	const end = pageEnd(s, at);
	return s.slice(at, end) + (end < s.length || at > 0 ? `\n[characters ${at + 1}-${end} of ${s.length}${end < s.length ? `; go on with at: ${end}` : ""}]` : "");
};
/** rb_full / rb_image rows stay under the DO's 2 MB row limit. */
const CHUNK = 500_000;
const chunks = (s: string) => Array.from({ length: Math.max(1, Math.ceil(s.length / CHUNK)) }, (_, k) => s.slice(k * CHUNK, (k + 1) * CHUNK));
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
	/**
	 * Merges a batch down to lo; returns how many merges landed. A batch lands whole (Unii fit), so between batches the view
	 * changes only at its end and cached prefixes keep. One blocked by unbuilt parents waits for them (Memory #fit retries as
	 * nodes land), unless it already sheds a whole hi (a backlog) or force (a fresh copy, nothing cached).
	 */
	fold(T: number, force = false) {
		const before = this.total();
		if (before > this.hi || force) this.merging = true;
		if (!this.merging) return 0;
		const view = this.view.slice();
		let total = before, n = 0;
		while (total > this.lo) {
			const k = mostDue(view, T, this.built);
			if (k < 0) break;
			const [l, a] = view[k];
			total -= this.size(view[k]) + this.size(view[k + 1]);
			view.splice(k, 2, [l + 1, a >> 1]);
			total += this.size(view[k]);
			n++;
		}
		const done = total <= this.lo;
		if (!done && !force && total > before - this.hi) return 0;
		this.view = view;
		if (done) this.merging = false;
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
	/** Busy nodes whose messages changed under them: their summary is dropped when it lands. */
	#stale = new Set<string>();
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
			CREATE TABLE IF NOT EXISTS rb_meta (k TEXT PRIMARY KEY, v TEXT);
			CREATE TABLE IF NOT EXISTS rb_hidden (i INTEGER PRIMARY KEY, g INTEGER, kind TEXT, text TEXT, why TEXT, date INTEGER);
			CREATE TABLE IF NOT EXISTS rb_full (i INTEGER, k INTEGER, text TEXT, PRIMARY KEY (i, k));
			CREATE TABLE IF NOT EXISTS rb_image (h TEXT, k INTEGER, mime TEXT, data TEXT, PRIMARY KEY (h, k))`);
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

	/** Logs a message. A tool result, job or Devin report over CAP is logged clipped (the VIEW and summaries read that), its whole text kept in rb_full for zoom's pages. */
	append(kind: Msg["kind"], text: string, date: number) {
		const m: Msg = { i: this.log.length, kind, text: kind === "echo" || kind === "job" || kind === "devin" ? cap(text) : text, date };
		this.sql.exec("INSERT INTO rb_msg (i, kind, text, date) VALUES (?, ?, ?, ?)", m.i, m.kind, m.text, m.date);
		if (m.text !== text) chunks(text).forEach((c, k) => this.sql.exec("INSERT OR REPLACE INTO rb_full (i, k, text) VALUES (?, ?, ?)", m.i, k, c));
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

	/**
	 * Rewrites message i and rebuilds every summary over it; a summary being written over the old text is thrown away when it lands.
	 * Its whole text goes too, unless kept (hide keeps it for restore; full() shows it only while the log holds its clip).
	 */
	redact(i: number, text: string, keep = false) {
		const m = this.log[i];
		if (!m) return false;
		m.text = text;
		this.sql.exec("UPDATE rb_msg SET text = ? WHERE i = ?", text, i);
		if (!keep) this.sql.exec("DELETE FROM rb_full WHERE i = ?", i);
		const over = (k: string) => { const [l, a] = k.split(":").map(Number); return (a << l) <= i && i < ((a + 1) << l); };
		for (const k of [...this.#nodes.keys()].filter(over)) {
			const [l, a] = k.split(":").map(Number);
			this.#nodes.delete(k);
			this.#sizes.delete(k);
			this.sql.exec("DELETE FROM rb_node WHERE l = ? AND i = ?", l, a);
		}
		for (const k of this.#busy) if (over(k)) this.#stale.add(k);
		this.#ready.add(`0:${i}`);
		this.#written.clear();
		this.pump();
		this.changed();
		return true;
	}

	/** Hidden messages: out of the VIEW and every summary (their text is a placeholder), the original kept in rb_hidden until restored. */
	hidden() { return this.sql.exec<Hidden>("SELECT g, i, kind, text, why, date FROM rb_hidden ORDER BY g, i").toArray().map((r) => ({ ...r })); }

	/** Hides messages as one group (restore brings the group back together); gives the group, or undefined if none could be hidden. */
	hide(ids: number[], why: string) {
		const taken = new Set(this.hidden().map((h) => h.i));
		const ids2 = [...new Set(ids)].filter((i) => this.log[i] && !taken.has(i)).sort((a, b) => a - b);
		if (!ids2.length) return undefined;
		const g = Number(this.get("hidden-g") ?? 0) + 1;
		this.set("hidden-g", String(g));
		for (const i of ids2) {
			const m = this.log[i];
			this.sql.exec("INSERT INTO rb_hidden (g, i, kind, text, why, date) VALUES (?, ?, ?, ?, ?, ?)", g, i, m.kind, m.text, why, Date.now());
			this.redact(i, `[hidden: ${why}. "restore" brings it back]`, true);
		}
		return g;
	}

	/** Restores hidden group g (default: the latest); gives the message ids restored. */
	restore(g?: number) {
		const all = this.hidden();
		const at = g ?? all.at(-1)?.g;
		const rows = all.filter((h) => h.g === at);
		for (const h of rows) { this.redact(h.i, h.text, true); this.sql.exec("DELETE FROM rb_hidden WHERE i = ?", h.i); }
		return rows.map((h) => h.i);
	}

	node(l: number, i: number) { return this.#nodes.get(`${l}:${i}`); }
	line([l, i]: Part) { return `${i << l}+${1 << l}|${(this.node(l, i) ?? UNBUILT).replace(/\n/g, " ")}`; }
	render() { return this.chat.view.map((p) => this.line(p)).join("\n"); }
	settled() { return this.chat.view.every(([l, i]) => this.node(l, i) !== undefined); }
	settle() { return this.settled() ? Promise.resolve() : new Promise<void>((r) => this.#waiters.push(r)); }

	/** Message i whole: its full text if it was logged clipped (and still is), else as logged. */
	full(i: number) {
		const m = this.log[i];
		if (!m) return undefined;
		const rows = this.sql.exec<{ text: string }>("SELECT text FROM rb_full WHERE i = ? ORDER BY k", i).toArray();
		const whole = rows.map((r) => r.text).join("");
		return rows.length && cap(whole) === m.text ? whole : m.text;
	}

	/** Keeps an image by its hash, once; its marker goes in the message text. */
	putImage(hash: string, img: Image) {
		if (this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM rb_image WHERE h = ?", hash).toArray()[0].n) return;
		chunks(img.data).forEach((c, k) => this.sql.exec("INSERT INTO rb_image (h, k, mime, data) VALUES (?, ?, ?, ?)", hash, k, img.mimeType, c));
	}
	image(hash: string): Image | undefined {
		const rows = this.sql.exec<{ mime: string; data: string }>("SELECT mime, data FROM rb_image WHERE h = ? ORDER BY k", hash).toArray();
		return rows.length ? { mimeType: rows[0].mime, data: rows.map((r) => r.data).join("") } : undefined;
	}

	/** n=1: message id whole, in CAP-char pages from `at`; n>1: the two half lines. */
	zoom(id: number, n: number, at = 0): string {
		const T = this.log.length;
		if (n < 1 || (n & (n - 1)) !== 0 || id % n !== 0 || id + n > T) return `error: ${id}+${n} is not a node`;
		if (n === 1) {
			const whole = this.full(id)!;
			if (at < 0 || (at > 0 && at >= whole.length)) return `error: message ${id} has ${whole.length} characters`;
			return `${this.log[id].kind}: ${page(whole, at)}`;
		}
		const l = Math.log2(n) - 1;
		const kids: Part[] = [[l, (id / n) * 2], [l, (id / n) * 2 + 1]];
		return kids.map((p) => this.line(p)).join("\n");
	}

	/** Lands a batch the views were waiting on, once the nodes it needed are built (between messages; Unii fit). */
	#fit() {
		const T = this.log.length;
		if (this.chat.merging && this.chat.fold(T) > 0) {
			this.comp.view = this.chat.view.slice();
			this.comp.merging = false;
			this.comp.fold(T, true);
		} else if (!this.comp.merging || this.comp.fold(T) === 0) return;
		this.#save();
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
					.then((text) => { if (!this.#stale.delete(key)) this.#store(l, i, text); })
					.catch((e) => {
						if (this.#stale.delete(key)) return;
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
		this.#fit();
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

	/** A node's source clipped to NODE bytes: what it keeps when the model gives no line (Unii); a merge keeps half of each side. */
	#clip(l: number, i: number) {
		if (l === 0) { const m = this.log[i]; return cutBytes(oneLine(`${m.kind}: ${m.text}`), NODE); }
		const half = (t: string) => cutBytes(oneLine(t), NODE / 2 - 1);
		return `${half(this.node(l - 1, 2 * i)!)}\n${half(this.node(l - 1, 2 * i + 1)!)}`;
	}

	/**
	 * Asks till a line fits, TRIES at most, the shortest kept. A retry sends the same blocks plus one note (the last line's size
	 * and where the limit cuts it), never earlier tries. No line in TRIES (refused or empty): the source clipped, so the tree
	 * goes on. A failed call throws and is retried later.
	 */
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
		let best: string | undefined, note = "";
		for (let t = 0; t < TRIES; t++) {
			const out = oneLine(await this.#call(key, chat, task + note));
			if (!out) continue;
			if (!best || bytes(out) < bytes(best)) best = out;
			if (bytes(out) <= NODE) return out;
			note = `\n\nToo long: your last line for this <input> was ${bytes(out)} bytes, over the ${NODE}-byte\nlimit. Write the whole line again, cutting just enough of the least valuable\nitems to fit before this cut:\n${cutBytes(out, NODE)}| ← LIMIT`;
		}
		if (best) return best; // the shortest try; a few bytes over is fine, sizes are measured
		console.error("compact", `${l}:${i}`, "no line; clipped");
		return this.#clip(l, i);
	}

	async #call(key: string, chat: string, task: string) {
		if (this.#written.has(key)) return this.llm(chat, task, () => {});
		while (this.#writing.has(key)) await this.#writing.get(key);
		if (this.#written.has(key)) return this.llm(chat, task, () => {});
		let open!: () => void;
		this.#writing.set(key, new Promise<void>((r) => (open = r)));
		const release = (ok: boolean) => {
			if (!this.#writing.has(key)) return;
			this.#writing.delete(key);
			if (ok) { this.#written.add(key); if (this.#written.size > 64) this.#written.delete(this.#written.values().next().value!); }
			open();
		};
		try { return await this.llm(chat, task, () => release(true)); }
		finally { release(false); }
	}
}

const covers = (v: Part[]) => { const p = v.at(-1); return p ? (p[1] + 1) << p[0] : 0; };
function cutBytes(s: string, n: number) {
	let cut = "";
	for (const ch of s) if (bytes(cut + ch) <= n) cut += ch; else break;
	return cut;
}
