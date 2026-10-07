import { local, next as cronNext } from "./cron.ts";

/** Heartbeat (openclaw/hermes style): a periodic turn in raubot's own conversation, silent unless something needs the user. */
export type Config = { every: string; activeHours: { start: string; end: string; tz: string }; ackMaxChars: number; paused: boolean; target: "last" | "app" | "imessage" };
export type Outcome = { at: number; status: string; reason?: string; note?: string };
export type State = Config & { lastFire?: number; nextDue?: number; last?: Outcome; tasks: Record<string, number>; wanted?: boolean };

export const DEFAULT: Config = { every: "30m", activeHours: { start: "07:00", end: "23:00", tz: "America/Los_Angeles" }, ackMaxChars: 300, paused: false, target: "last" };
export const TAG = "[heartbeat]";
export const PROMPT = "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";
/** Retry delay while raubot is busy (ms). */
export const RETRY = 60_000;
/** A heartbeat turn with no reply after this long is closed as failed. */
export const STUCK = 30 * 60_000;
/** Due-task slack, so a task with every: 30m runs on every 30m tick despite timer jitter. */
const SLACK = 2 * 60_000;

/** "30m", "2h", "1d", "90s" or "1h30m" in ms; undefined if malformed. */
export const duration = (s: string): number | undefined => {
	const t = s.trim().toLowerCase();
	if (!/^(\d+(\.\d+)?\s*(ms|s|m|h|d)\s*)+$/.test(t)) return undefined;
	const unit: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
	let ms = 0;
	for (const [, n, , u] of t.matchAll(/(\d+(\.\d+)?)\s*(ms|s|m|h|d)/g)) ms += Number(n) * unit[u];
	return ms > 0 ? ms : undefined;
};

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + (m || 0); };

/** Whether t falls inside the active window (end exclusive; a window like 22:00-06:00 wraps midnight). */
export const active = (t: number, w: Config["activeHours"]) => {
	const p = local(t, w.tz), now = p.h * 60 + p.m, a = minutes(w.start), b = minutes(w.end);
	return a === b ? true : a < b ? now >= a && now < b : now >= a || now < b;
};

/** The next tick from `from`: from + every, moved to the window's start if that lands outside it. */
export const nextTick = (from: number, c: Config) => {
	const step = duration(c.every) ?? 30 * 6e4;
	const t = from + step;
	if (active(t, c.activeHours)) return t;
	const [h, m] = c.activeHours.start.split(":").map(Number);
	return cronNext(`${m || 0} ${h} * * *`, c.activeHours.tz, t - 60_000) ?? t;
};

/** What the alarm should do now. Missed ticks coalesce into one fire; the timer re-anchors on each fire. */
export const decide = (now: number, s: State, busy: boolean): { act: "wait" | "defer" | "fire" | "quiet"; at?: number } => {
	if (s.paused && !s.wanted) return { act: "wait" };
	const due = s.wanted || (s.nextDue ?? 0) <= now;
	if (!due) return { act: "wait", at: s.nextDue };
	if (!s.wanted && !active(now, s.activeHours)) return { act: "quiet", at: nextTick(now - (duration(s.every) ?? 0), s) };
	if (busy) return { act: "defer", at: now + RETRY };
	return { act: "fire", at: nextTick(now, s) };
};

/** Remove HEARTBEAT_OK at the start or end of a reply (with stray markup/punctuation around it). Middle mentions stay. */
export const strip = (reply: string) => {
	const tok = /HEARTBEAT_OK/;
	let t = reply.trim(), had = false;
	const head = /^[\s*_`"'>#-]*HEARTBEAT_OK[\s*_`"'.!:,-]*/, tail = /[\s*_`"'(-]*HEARTBEAT_OK[\s*_`"'.!)]*$/;
	if (head.test(t)) { t = t.replace(head, ""); had = true; }
	if (tail.test(t)) { t = t.replace(tail, ""); had = true; }
	return { text: t.trim(), had: had || (t === "" && tok.test(reply)) };
};

/** A heartbeat reply's fate: "ok" is dropped (a short remainder is kept as a note); "alert" goes to the user. */
export const judge = (reply: string, ackMaxChars = DEFAULT.ackMaxChars): { kind: "ok" | "alert"; text: string } => {
	const r = strip(reply);
	if (!r.text || /^NO_REPLY$/.test(r.text)) return { kind: "ok", text: "" };
	if (r.had && r.text.length <= ackMaxChars) return { kind: "ok", text: r.text };
	return { kind: "alert", text: r.text };
};

/** A reply outside heartbeats: a lone stray token at the start or end is dropped. */
export const scrub = (reply: string) => { const r = strip(reply); return r.had ? r.text : reply; };

/** True when HEARTBEAT.md has nothing to do: only headings, comments, blanks or empty checklist stubs. */
export const empty = (md: string) => md.replace(/<!--[\s\S]*?-->/g, "").split("\n").every((l) => {
	const s = l.trim();
	return !s || /^#+(\s|$)/.test(s) || /^[-*+]\s*(\[[ xX]?\])?\s*$/.test(s) || /^(tasks:)\s*$/i.test(s);
});

export type Task = { name: string; every: number; prompt: string };

/** Splits HEARTBEAT.md into its `tasks:` block (items "- name: x" with indented "every:" / "interval:" and "prompt:") and the rest. */
export const parse = (md: string): { body: string; tasks: Task[] } => {
	const lines = md.split("\n"), tasks: Task[] = [], body: string[] = [];
	let inBlock = false, cur: Partial<Task> & { lines?: string[] } | undefined;
	const close = () => { if (cur?.name) tasks.push({ name: cur.name, every: cur.every ?? 30 * 6e4, prompt: (cur.prompt ?? cur.lines?.join(" ") ?? "").trim() }); cur = undefined; };
	for (const l of lines) {
		if (/^tasks:\s*$/i.test(l.trim()) && !/^\s/.test(l)) { inBlock = true; continue; }
		if (inBlock) {
			if (l.trim() && !/^\s/.test(l) && !/^-\s/.test(l)) { close(); inBlock = false; body.push(l); continue; }
			const item = /^\s*-\s+name:\s*(.+)$/.exec(l);
			if (item) { close(); cur = { name: item[1].trim(), lines: [] }; continue; }
			const kv = /^\s+(-\s+)?(every|interval|prompt):\s*(.*)$/.exec(l);
			if (kv && cur) { if (kv[2] === "prompt") cur.prompt = kv[3]; else cur.every = duration(kv[3]) ?? cur.every; continue; }
			if (l.trim() && cur) { cur.lines!.push(l.trim()); continue; }
			continue;
		}
		body.push(l);
	}
	close();
	return { body: body.join("\n").trim(), tasks };
};

/** Tasks whose interval has passed since their last run (never-run ones are due). */
export const dueTasks = (tasks: Task[], last: Record<string, number>, now: number) =>
	tasks.filter((t) => now - (last[t.name] ?? 0) + SLACK >= t.every);

/** The heartbeat turn's input. */
export const input = (o: { stamp: string; md?: string; due: Task[]; digest: string; manual?: boolean }) => [
	`${TAG} ${o.stamp}${o.manual ? " (started by hand)" : ""}. ${PROMPT}`,
	o.md === undefined ? "HEARTBEAT.md: (missing)" : `HEARTBEAT.md:\n${o.md}`,
	o.due.length ? `Due tasks this tick:\n${o.due.map((t) => `- ${t.name}: ${t.prompt}`).join("\n")}` : "",
	`What the user himself sent since the last heartbeat (drop items he already handled; act on his commitments):\n${o.digest || "(nothing)"}`,
	"Reply contract: HEARTBEAT_OK alone if nothing needs the user. If you did something quietly, put one short line after HEARTBEAT_OK (kept as a note, not sent). Otherwise reply only the alert: 1-3 short plain-text lines.",
].filter(Boolean).join("\n\n");

/** Caps the sent-message digest (~3k tokens). */
export const capDigest = (s: string, max = 12_000) => (s.length <= max ? s : `${s.slice(0, max)}\n[... ${s.length - max} chars cut]`);
