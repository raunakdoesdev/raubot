// Pure helpers for the box file browser (tested without a Worker).

/** Which box a request means: "main" (raubot's own) or "agent-<id>" (a subagent's). undefined: invalid. */
export const boxName = (v: string | null | undefined) => {
	if (!v || v === "0" || v === "main") return "main";
	const m = /^(?:agent-)?(\d{1,9})$/.exec(v);
	return m ? `agent-${Number(m[1])}` : undefined;
};

/** The box an agent name from boxName/pagePath really runs in: a vm "shared" subagent runs in its caller's box (lookup gives its stored info.box), others in their own. */
export const resolveBox = async (name: string, lookup: (id: number) => Promise<string | undefined>) =>
	name === "main" ? name : ((await lookup(Number(name.slice("agent-".length)))) ?? name);

/** Largest slice one ranged read returns (video/audio stream in pieces of this). */
export const SLICE = 4 * 2 ** 20;

/** A single "bytes=a-b" / "bytes=a-" / "bytes=-n" range against size, clipped to SLICE. undefined: no/unsupported header. "bad": unsatisfiable. */
export const byteRange = (h: string | null, size: number): { start: number; end: number } | "bad" | undefined => {
	if (!h) return undefined;
	const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
	if (!m || (!m[1] && !m[2])) return undefined;
	let start: number, end: number;
	if (!m[1]) { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
	else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
	if (start >= size || end < start) return "bad";
	return { start, end: Math.min(end, start + SLICE - 1) };
};

/** /file/<rest>: "~<id>/" prefix picks a subagent's box; the rest maps like before (scratch/x -> /scratch/x, x -> /workspace/x, ~root/... -> /...). */
export const pagePath = (rest: string) => {
	const p = rest.split("/").map((x) => { try { return decodeURIComponent(x); } catch { return x; } }).join("/");
	const m = /^~(\d{1,9})\/(.*)$/.exec(p);
	const box = m ? `agent-${Number(m[1])}` : "main", r = m ? m[2] : p;
	const path = r.startsWith("~root/") ? r.slice(5) : /^(scratch|workspace)(\/|$)/.test(r) ? "/" + r : "/workspace/" + r;
	return { box, path };
};
