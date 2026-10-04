import { CAP, COMPACT_PROMPT, JOBS, NODE, RETRY, TRIES, VIEW } from "./prompts.ts";

export type Msg = { i: number; kind: "user" | "talk" | "tool" | "echo"; text: string; date: number };
type Part = [l: number, i: number];
type Llm = (system: string, prompt: string) => Promise<string>;

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cutBytes = (s: string, n: number) => {
	let out = "";
	for (const ch of s) if (bytes(out + ch) <= n) out += ch; else break;
	return out;
};
export const cap = (s: string) =>
	s.length <= CAP ? s : `${s.slice(0, CAP / 2)}\n[... ${s.length - CAP} chars cut ...]\n${s.slice(-CAP / 2)}`;

/** Memory: append-only log, binary summary tree, and a bounded view folded over both. */
export class Memory {
	log: Msg[] = [];
	view: Part[] = [];
	#nodes = new Map<string, string>();
	#busy = new Set<string>();
	#retryAt = new Map<string, number>();
	#waiters: (() => void)[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;

	sql: SqlStorage;
	llm: Llm;
	changed: () => void;

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
		for (let i = 0; i < this.log.length; i++) this.#push(i);
	}

	get(k: string) { return this.sql.exec<{ v: string }>("SELECT v FROM rb_meta WHERE k = ?", k).toArray()[0]?.v; }
	set(k: string, v: string) { this.sql.exec("INSERT OR REPLACE INTO rb_meta (k, v) VALUES (?, ?)", k, v); }

	append(kind: Msg["kind"], text: string, date: number) {
		const m: Msg = { i: this.log.length, kind, text: kind === "echo" ? cap(text) : text, date };
		this.sql.exec("INSERT INTO rb_msg (i, kind, text, date) VALUES (?, ?, ?, ?)", m.i, m.kind, m.text, m.date);
		this.log.push(m);
		this.#push(m.i);
		this.pump();
		this.changed();
	}

	node(l: number, i: number) { return this.#nodes.get(`${l}:${i}`); }
	line([l, i]: Part) { return `${i << l}+${1 << l}|${this.node(l, i) ?? "(summarizing...)"}`; }
	render() { return this.view.map((p) => this.line(p)).join("\n"); }
	settled() { return this.view.every(([l, i]) => this.node(l, i) !== undefined); }
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

	/** Append message i to the view, then merge the most due sibling pairs until it fits. */
	#push(i: number) {
		this.view.push([0, i]);
		const T = this.log.length;
		const size = (p: Part) => (this.node(...p) === undefined ? NODE + 16 : bytes(this.line(p))) + 1;
		let total = this.view.reduce((s, p) => s + size(p), 0);
		while (total > VIEW) {
			let best = -1, due = -1;
			for (let k = 0; k + 1 < this.view.length; k++) {
				const [l, a] = this.view[k], [m, b] = this.view[k + 1];
				if (l !== m || a % 2 !== 0 || b !== a + 1) continue;
				const d = (T - (a << l)) / 2 ** (l + 2);
				if (d > due) { due = d; best = k; }
			}
			if (best < 0) break;
			const [l, a] = this.view[best];
			total -= size(this.view[best]) + size(this.view[best + 1]);
			this.view.splice(best, 2, [l + 1, a >> 1]);
			total += size(this.view[best]);
		}
	}

	/** End of the first view line not yet built: the tree is built up to here. */
	#frontier() {
		const p = this.view.find(([l, i]) => this.node(l, i) === undefined);
		return p ? (p[1] + 1) << p[0] : this.log.length;
	}

	#ready(l: number, i: number) {
		if (this.node(l, i) !== undefined || this.#busy.has(`${l}:${i}`)) return false;
		if ((this.#retryAt.get(`${l}:${i}`) ?? 0) > Date.now()) return false;
		return l === 0 ? i < this.log.length : this.node(l - 1, 2 * i) !== undefined && this.node(l - 1, 2 * i + 1) !== undefined;
	}

	/** Start compactor jobs: view lines first (oldest first), then the rest of the tree up to the end of the first unbuilt line. */
	pump() {
		const T = this.log.length, frontier = this.#frontier();
		const jobs: Part[] = this.view.filter(([l, i]) => this.#ready(l, i));
		for (let l = 0; 1 << l <= T; l++)
			for (let i = 0; (i + 1) << l <= Math.min(T, frontier); i++)
				if (this.#ready(l, i) && !jobs.some(([m, j]) => m === l && j === i)) jobs.push([l, i]);
		jobs.sort((a, b) => (a[1] << a[0]) - (b[1] << b[0]) || a[0] - b[0]);
		for (const [l, i] of jobs) {
			if (this.#busy.size >= JOBS) break;
			const key = `${l}:${i}`;
			this.#busy.add(key);
			this.#build(l, i)
				.then((text) => {
					this.#nodes.set(key, text);
					this.sql.exec("INSERT OR REPLACE INTO rb_node (l, i, text) VALUES (?, ?, ?)", l, i, text);
					this.#retryAt.delete(key);
				})
				.catch((e) => {
					console.error("compact", key, e);
					this.#retryAt.set(key, Date.now() + RETRY);
					clearTimeout(this.#timer);
					this.#timer = setTimeout(() => this.pump(), RETRY);
				})
				.finally(() => {
					this.#busy.delete(key);
					if (this.settled()) for (const w of this.#waiters.splice(0)) w();
					this.changed();
					this.pump();
				});
		}
	}

	pending() { return this.#busy.size > 0 || !this.settled(); }

	async #build(l: number, i: number): Promise<string> {
		const start = i << l;
		let target: string;
		if (l === 0) {
			const m = this.log[i];
			target = oneLine(`${m.kind}: ${m.text}`);
			if (bytes(target) <= NODE) return target;
			target = `${m.kind}: ${m.text}`;
		} else {
			const a = this.node(l - 1, 2 * i)!, b = this.node(l - 1, 2 * i + 1)!;
			if (bytes(a) + 1 + bytes(b) <= NODE) return `${a} ${b}`;
			target = `${a}\n${b}`;
		}
		const context = this.view
			.filter(([m, j]) => ((j + 1) << m) <= start && this.node(m, j) !== undefined)
			.map(([m, j]) => this.node(m, j))
			.join("\n");
		let best: string | undefined, feedback = "";
		for (let t = 0; t < TRIES; t++) {
			const out = oneLine(await this.llm(COMPACT_PROMPT,
				`CONTEXT:\n${context || "(start of conversation)"}\n\nTARGET:\n${target}\n\nWrite one summary line of the TARGET, at most ${NODE} bytes.${feedback}`));
			if (!out) continue;
			if (!best || bytes(out) < bytes(best)) best = out;
			if (bytes(out) <= NODE) return out;
			feedback = `\n\nYour last attempt was ${bytes(out)} bytes, over the ${NODE} byte limit:\n${out}\nWrite it shorter.`;
		}
		if (!best) throw new Error("compactor returned nothing");
		return cutBytes(best, NODE);
	}
}
