/**
 * Buffers the parts of one logical message: iMessage (Photon/Spectrum) delivers a long text, a link and a file
 * sent together as separate webhooks a second or two apart. Parts from the same key (channel + conversation)
 * are held until `gap` ms pass with no new part, or `max` ms after the first part, then flushed as one, in
 * arrival order. Each part's value may be a promise (attachments still downloading); order follows arrival,
 * not download completion. Different keys never merge.
 */
export type CoalesceOpts<T> = {
	gap: number;
	max: number;
	flush: (key: string, parts: T[]) => void | Promise<void>;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (t: unknown) => void;
};

type Group<T> = { parts: (T | Promise<T>)[]; first: number; timer?: unknown; done: () => void; settled: Promise<void> };

export class Coalescer<T> {
	#groups = new Map<string, Group<T>>();
	#o: Required<CoalesceOpts<T>>;
	constructor(o: CoalesceOpts<T>) {
		this.#o = { now: Date.now, setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>), ...o };
	}

	/** Adds a part; the returned promise settles once its group has been flushed (for waitUntil). */
	add(key: string, part: T | Promise<T>): Promise<void> {
		const o = this.#o, now = o.now();
		let g = this.#groups.get(key);
		if (!g) {
			let done!: () => void;
			const settled = new Promise<void>((r) => (done = r));
			g = { parts: [], first: now, done, settled };
			this.#groups.set(key, g);
		}
		g.parts.push(part);
		if (g.timer !== undefined) o.clearTimer(g.timer);
		const wait = Math.max(0, Math.min(o.gap, g.first + o.max - now));
		const grp = g;
		g.timer = o.setTimer(() => void this.#flush(key, grp), wait);
		return g.settled;
	}

	pending(key?: string) { return key ? (this.#groups.get(key)?.parts.length ?? 0) : [...this.#groups.values()].reduce((n, g) => n + g.parts.length, 0); }

	async #flush(key: string, g: Group<T>) {
		if (this.#groups.get(key) === g) this.#groups.delete(key);
		try {
			const parts = await Promise.all(g.parts);
			await this.#o.flush(key, parts);
		} catch (e) {
			console.error("coalesce flush", e);
		} finally { g.done(); }
	}
}

/** One part's text with its attachments right after it, so order is kept when parts are joined. */
export const joinParts = (parts: { text: string; files: string[] }[]) =>
	parts.map((p) => [p.text, ...p.files.map((f) => `[attached: ${f}]`)].filter(Boolean).join("\n")).filter(Boolean).join("\n");
