/** A memory-tree node from /tree.json: level `l`, index `i` at that level, covering messages `id`..`id+n-1`. */
export type P = { l: number; i: number; id: number; n: number; kind?: string; text?: string | null; from?: number; to?: number; seen: "view" | "open" | "fold" };
export type Hit = { id: number; kind: string; date: number; snippet: string };
export type Usage = { date: number; input: number; output: number; cacheRead: number; cacheWrite: number };
export type Top = { log: number; bytes: number; budget: number; pending: boolean; view: P[]; roots: P[]; usage: Usage[] };

export const get = <T = any>(q = ""): Promise<T> => fetch(`/tree.json${q}`).then((r) => r.json());

const KIND: Record<string, string> = { user: "#e0af68", talk: "#9ece6a", tool: "#bb9af7", echo: "#7dcfff", job: "#ff9e64" };
export const kindColor = (k = "") => KIND[k] ?? "#888";
export const color = (p: P) => (p.l ? `hsl(${(210 + p.l * 32) % 360} 55% 62%)` : kindColor(p.kind));
export const label = (p: P) => (p.l ? `L${p.l}` : (p.kind ?? "msg"));

export const when = (t: number) => {
	const d = new Date(t), time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
};
const span = (p: P) => (p.from == null ? "" : p.n === 1 || p.from === p.to ? when(p.from) : `${when(p.from)} – ${when(p.to!)}`);
export const meta = (p: P) => (p.l ? `#${p.id}–${p.id + p.n - 1} · ${p.n} msgs · ${span(p)}` : `#${p.id} · ${span(p)}`);

/** Rows in the Tree tab, by "l:i", so search and the strip can open a path down to a node. */
export const rows = new Map<string, { toggle: (open?: boolean) => Promise<void>; flash: () => void }>();
