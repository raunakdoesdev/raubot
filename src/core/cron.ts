import { Data, Effect } from "effect";
import { kv } from "./fx.ts";

/** A scheduled prompt. schedule: 5-field cron (min hour dom mon dow) in tz, or an ISO time for a one-shot. */
export type Cron = {
	id: string; schedule: string; tz: string; prompt: string;
	/** "agent": a fresh subagent runs the prompt and its reply goes to channel. "turn": the prompt goes into raubot's own conversation. */
	mode: "agent" | "turn";
	channel: string;
	/** Bash test run first; exit 0 skips this run. {date} is today (YYYY-MM-DD) in tz. */
	unless?: string;
	timeout: number; enabled: boolean; next?: number; last?: { at: number; status: string };
};

export class CronError extends Data.TaggedError("CronError")<{ message: string }> {}

export const TZ = "America/Los_Angeles";
/** Replies that mean "nothing to say": the run ends silent (openclaw's HEARTBEAT_OK / NO_REPLY). */
export const SILENT = /^\s*(HEARTBEAT_OK|NO_REPLY)?\s*$/;

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/** One cron field as the set of values it allows: *, lists, a-b ranges and /steps. */
const field = (src: string, [lo, hi]: [number, number]) => {
	const out = new Set<number>();
	for (const part of src.split(",")) {
		const [range, step = "1"] = part.split("/");
		const [a, b] = range === "*" ? [lo, hi] : range.split("-").map(Number);
		const end = b ?? (part.includes("/") ? hi : a), by = Number(step);
		if (![a, end, by].every(Number.isInteger) || a < lo || end > hi || a > end || by < 1) throw new CronError({ message: `bad cron field "${src}"` });
		for (let v = a; v <= end; v += by) out.add(v);
	}
	return out;
};

const fmt = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock parts of t in tz. */
export const local = (t: number, tz: string) => {
	let f = fmt.get(tz);
	if (!f) fmt.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })));
	const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
	return { y: +p.year, mon: +p.month, d: +p.day, h: +p.hour, m: +p.minute, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
};

export const today = (tz: string, t = Date.now()) => { const p = local(t, tz); return `${p.y}-${String(p.mon).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; };

const MIN = 60_000, HOUR = 3_600_000;
const oneShot = (s: string) => /^\d{4}-\d\d-\d\dT/.test(s);

/** The first run strictly after `after`, or undefined if there is none. Steps by hour while the date or hour can't match, so DST days are safe. */
export const next = (schedule: string, tz: string, after: number): number | undefined => {
	if (oneShot(schedule)) { const t = Date.parse(schedule); if (Number.isNaN(t)) throw new CronError({ message: `bad time "${schedule}"` }); return t > after ? t : undefined; }
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5) throw new CronError({ message: `cron needs 5 fields: "${schedule}"` });
	const [mi, hr, dom, mon, dow] = parts.map((p, i) => field(p, RANGES[i]));
	if (dow.has(7)) dow.add(0);
	const anyDom = parts[2] === "*", anyDow = parts[4] === "*";
	let t = Math.floor(after / MIN) * MIN + MIN;
	for (let i = 0; i < 24 * 366 * 5 + 60 * 24; i++) {
		const p = local(t, tz);
		const day = anyDom || anyDow ? dom.has(p.d) && dow.has(p.dow) : dom.has(p.d) || dow.has(p.dow);
		if (!mon.has(p.mon) || !day || !hr.has(p.h)) { t += HOUR - p.m * MIN; continue; }
		if (mi.has(p.m)) return t;
		t += MIN;
	}
	return undefined;
};

/** How late a run may start: half the period, 2 min to 2 h (hermes' catch-up window). */
export const grace = (c: Cron, due: number) => {
	const after = oneShot(c.schedule) ? undefined : next(c.schedule, c.tz, due);
	return Math.min(2 * HOUR, Math.max(2 * MIN, after ? (after - due) / 2 : 2 * HOUR));
};

const key = (id: string) => `cron:${id}`;
export const list = kv.list<Cron>("cron:").pipe(Effect.map((m) => [...m.values()].sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity))));

export const put = (c: Omit<Cron, "next" | "last"> & Partial<Pick<Cron, "last">>) => Effect.gen(function* () {
	if (!/^[\w-]{1,40}$/.test(c.id)) return yield* new CronError({ message: "id: 1-40 letters, digits, - or _" });
	yield* Effect.try({ try: () => new Intl.DateTimeFormat("en-US", { timeZone: c.tz }), catch: () => new CronError({ message: `bad time zone "${c.tz}"` }) });
	const n = yield* Effect.try({ try: () => next(c.schedule, c.tz, Date.now()), catch: (e) => (e instanceof CronError ? e : new CronError({ message: String(e) })) });
	const cron: Cron = { ...c, next: n, enabled: c.enabled && n !== undefined };
	yield* kv.put({ [key(c.id)]: cron });
	return cron;
});

export const remove = (ids: string[]) => kv.delete(ids.map(key));

export const get = (id: string) => kv.get<Cron>(key(id));

/** Claims every due cron: advances `next` before the run starts (at most once across restarts), and marks runs past grace as missed. Gives the ones to run now. */
export const due = (now: number) => Effect.gen(function* () {
	const run: Cron[] = [];
	for (const c of yield* list) {
		if (!c.enabled || c.next === undefined || c.next > now) continue;
		const late = now - c.next > grace(c, c.next);
		const n = next(c.schedule, c.tz, now);
		yield* kv.put({ [key(c.id)]: { ...c, next: n, enabled: n !== undefined, last: { at: now, status: late ? "missed" : "started" } } satisfies Cron });
		if (!late) run.push(c);
	}
	return run;
});

export const record = (id: string, status: string) => Effect.gen(function* () {
	const c = yield* get(id);
	if (c) yield* kv.put({ [key(id)]: { ...c, last: { at: Date.now(), status } } });
});

/** When the alarm must fire next for crons. */
export const wake = list.pipe(Effect.map((cs) => cs.filter((c) => c.enabled && c.next !== undefined).reduce((a, c) => Math.min(a, c.next!), Infinity)));
