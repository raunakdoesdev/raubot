import { Data, Effect } from "effect";
import Value from "typebox/value";
import { kv } from "./fx.ts";
import { SUBAGENT, WRITER } from "./prompts.ts";

export class AgentError extends Data.TaggedError("AgentError")<{ message: string }> {}

/** What subagents need from the host: conversations it can create once, reopen after a restart, and steer or stop. */
export type AgentHost = {
	/** writer: a copy writer on Muse Wonder with only file tools, no VIEW or memory. */
	/** box: run it in this existing box (vm: "shared"), else in its own new one. */
	create(computer: boolean, writer?: boolean, box?: string): Promise<number>;
	/** Submit a message (idempotent per requestId), wait for the run, return the last assistant text. */
	ask(id: number, content: string, requestId: string): Promise<string>;
	/** Whether a reply stops to ask for a confirmation the user doesn't need to give (anything but money or sharing data). */
	needless(reply: string): Promise<boolean>;
	running(id: number): Promise<boolean>;
	last(id: number): Promise<string>;
	steer(id: number, message: string): Promise<void>;
	stop(id: number): Promise<void>;
	/** running: the build this raubot instance runs; deployed: the newest build the edge has reported. */
	builds(): { running: string; deployed: string };
	/** When its conversation last moved, and what it is doing now. */
	progress(id: number): Promise<Progress>;
	/** Tell whoever should act on a stalled subagent: its parent subagent while that runs, else raubot. */
	notify(info: Info, text: string): Promise<void>;
};

/** at: the newest message's time. error: the last assistant message failed. retryAt: the harness has a retry queued. tools: tool calls in flight. */
export type Progress = { running: boolean; at: number; error?: string; retryAt?: number; tools: number };

/** No new message for this long while running is a stall. Long tool calls (bash up to 15 min) can trip it: the notice says so. */
export const STALL_MS = 10 * 60_000;

/** The longest a codemode script may run: bash's 900 s maximum plus a minute, so a nested bash call gets its full timeout and a hung call outlives STALL_MS. */
export const SCRIPT_MAX_MS = 960_000;

/** Why a subagent looks stuck, or undefined. An error is a stall only once no retry is queued; a retry due long ago is one too. */
export const stalled = (p: Progress, now: number): string | undefined => {
	if (p.retryAt !== undefined) return now - p.retryAt > STALL_MS ? "its model retry never ran" : undefined;
	if (p.error) return p.running ? "its model call failed and no retry is queued" : "it stopped on a model error";
	if (p.running && now - p.at > STALL_MS) return p.tools ? `no new step in ${Math.round((now - p.at) / 60_000)} min (a tool call is still in flight, maybe a long one)` : `no new step in ${Math.round((now - p.at) / 60_000)} min`;
	return undefined;
};

/** A build id: the first 8 characters of the Worker version id, as wrangler prints it ("dev" without the binding). */
export const buildOf = (v?: { id: string }) => v?.id.slice(0, 8) ?? "dev";

/** The header the edge Worker sets on every request to raubot: its build, the latest deployed one. */
export const BUILD_HEADER = "x-raubot-build";

/** Where a subagent runs: "own" is a new box agent-<id> forked from raubot's snapshot; "shared" is its caller's box. */
export type Vm = "own" | "shared";

/** depth: raubot is 0, its subagents 1, theirs 2 (missing on old records: 1). parent: the conversation that started it. box: the box it runs in (missing on old records: agent-<id>). build: the raubot build that started it. */
export type Info = { id: number; task: string; computer?: boolean; writer?: boolean; started: number; depth?: number; parent?: number; vm?: Vm; box?: string; build?: string };

/** How deep non-computer subagents may nest (raubot is depth 0). Computer agents are leaves: they never start agents, but any non-computer subagent may start one. */
export const MAX_DEPTH = 2;

/** Why `caller` (undefined: raubot) may not start a subagent, or undefined if it may. */
export const refuse = (caller: Info | undefined, computer: boolean, writer = false) => {
	if (caller?.computer) return "A computer agent can't start subagents.";
	if (caller?.writer) return "A writer agent can't start subagents.";
	if (computer && writer) return "Pick computer or writer, not both.";
	const depth = caller ? caller.depth ?? 1 : 0;
	if (!computer && !writer && depth + 1 > MAX_DEPTH) return `Subagents nest at most ${MAX_DEPTH} deep: start a computer agent or do it yourself.`;
	return undefined;
};

const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => new AgentError({ message: String(e) }) });

const mismatch = (schema: object, reply: string) => {
	try {
		const v: unknown = JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, ""));
		if (Value.Check(schema, v)) return { v };
		return { err: [...Value.Errors(schema, v)].slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ") };
	} catch (e) { return { err: String(e) }; }
};

export const APPROVED = "Approved. Go ahead, and don't ask for confirmation again unless it's to spend or move money or to send data or information to other people (messages, emails, shares, approvals or replies as the user).";

/** `tools.agent`: run a task on a subagent keyed by `key` (stable across restarts). A string reply, or with `schema` a validated value. */
/** from.box: the caller's box, where a vm: "shared" subagent runs. */
export const agent = (host: AgentHost, key: string, { task, schema, computer = false, writer = false, vm = "own" }: { task: string; schema?: object; computer?: boolean; writer?: boolean; vm?: Vm }, { box, ...from }: { depth: number; parent?: number; box: string } = { depth: 1, box: "main" }) => Effect.gen(function* () {
	let id = yield* kv.get<number>(key);
	if (!id) {
		const shared = vm === "shared" ? box : undefined;
		id = yield* attempt(() => host.create(computer, writer, shared));
		yield* kv.put({ [key]: id, [`agentinfo:${id}`]: { id, task, computer, ...(writer && { writer }), started: Date.now(), ...from, vm, box: shared ?? `agent-${id}`, build: host.builds().running } satisfies Info });
	}
	const ask = (content: string, n: string) => attempt(() => host.ask(id, content, `${key}:${n}`));
	const shape = schema ? `\n\nReply with only JSON (no prose, no code fence) matching this JSON Schema:\n${JSON.stringify(schema)}` : "";
	// The subagent's rules ride in its first message, after the view: its system prompt and tools stay byte-identical to raubot's, so the prefix is a cache hit.
	// A writer gets no VIEW: its own short brief instead.
	let reply = yield* ask(`<instructions>\n${writer ? WRITER : SUBAGENT}\n</instructions>\n\nTask: ${task}${shape}`, "0");
	for (let k = 0; k < 5 && (yield* attempt(() => host.needless(reply))); k++) reply = yield* ask(APPROVED, `ok${k}`);
	if (!schema) return reply as unknown;
	for (let n = 1; ; n++) {
		const r = mismatch(schema, reply);
		if (!("err" in r)) return r.v;
		if (n > 2) return yield* new AgentError({ message: `Subagent reply doesn't match the schema: ${r.err}` });
		reply = yield* ask(`That reply doesn't match the schema (${r.err}). Reply again with only the JSON.${shape}`, String(n));
	}
});

/** Subagents older than this are never watched. */
const WATCH_AGE = 2 * 86400_000;

/** One stall pass: every recent subagent that is stuck gets one "[agent <id> stalled]" notice per stall (same progress time and reason). An ask that saw the outcome itself marks it seen (`seen`), so its job reports it instead. Returns how many still run, so the caller keeps watching. */
export const watchdog = (host: AgentHost, now = Date.now()) => Effect.gen(function* () {
	const recent = [...(yield* kv.list<Info>("agentinfo:")).values()].filter((a) => a && typeof a.id === "number" && now - a.started < WATCH_AGE).sort((a, b) => b.started - a.started).slice(0, 40);
	let live = 0;
	for (const a of recent) {
		const p = yield* attempt(() => host.progress(a.id)).pipe(Effect.orElseSucceed(() => undefined));
		if (!p) continue;
		if (p.running) live++;
		// An idle agent's old error is stale news; only fresh ones are worth a notice.
		else if (now - p.at > 3600_000) continue;
		const why = stalled(p, now);
		if (!why) continue;
		const sig = `${p.at}:${why.replace(/\d+ min/, "")}`;
		if ((yield* kv.get<string>(`stall:${a.id}`)) === sig) continue;
		yield* kv.put({ [`stall:${a.id}`]: sig });
		const last = yield* attempt(() => host.last(a.id)).pipe(Effect.orElseSucceed(() => ""));
		yield* attempt(() => host.notify(a, stallNotice(a, why, p, last)));
	}
	return live;
});

/** Mark a subagent's current state as already reported (its ask returned it to a job), so the watchdog stays quiet about it. */
export const seen = (host: AgentHost, id: number, now = Date.now()) => Effect.gen(function* () {
	const p = yield* attempt(() => host.progress(id)).pipe(Effect.orElseSucceed(() => undefined));
	const why = p && stalled(p, now);
	if (why) yield* kv.put({ [`stall:${id}`]: `${p.at}:${why.replace(/\d+ min/, "")}` });
});

export const stallNotice = (a: Info, why: string, p: Progress, last: string) =>
	`[agent ${a.id} stalled] ${why}; status ${p.running ? "running" : "idle"}, last progress ${new Date(p.at).toISOString()}. Task: ${a.task.slice(0, 160)}\nLast output: ${last.slice(-800) || "(none)"}\nNudge it with tools.agents({ send }), or stop it and start a fresh one with the same task.`;

const LIST = 20;
const SNIPPET = 600;

/** `tools.agents`: list subagents (newest first), steer one with `send` (or, if it's done, ask it a follow-up and get its reply), `stop` some. */
export const agents = (host: AgentHost, { send, stop = [] }: { send?: { id: number; message: string }; stop?: number[] }) => Effect.gen(function* () {
	const known = [...(yield* kv.list<Info>("agentinfo:")).values()];
	const check = (id: number) => (known.some((a) => a.id === id) ? Effect.void : Effect.fail(new AgentError({ message: `No subagent ${id}.` })));
	for (const id of stop) { yield* check(id); yield* attempt(() => host.stop(id)); }
	if (send) {
		yield* check(send.id);
		if (yield* attempt(() => host.running(send.id))) {
			yield* attempt(() => host.steer(send.id, send.message));
			return `Sent to subagent ${send.id}; it reads it at its next step.`;
		}
		return yield* attempt(() => host.ask(send.id, send.message, `send:${send.id}:${Date.now()}`));
	}
	const b = host.builds();
	const stale = b.running !== b.deployed && `raubot runs build ${b.running} but ${b.deployed} is deployed: new code goes live once no turn is in flight`;
	return yield* Effect.forEach(known.sort((a, b) => b.started - a.started).slice(0, LIST), (a) => Effect.gen(function* () {
		const [running, last, p] = yield* Effect.all([attempt(() => host.running(a.id)), attempt(() => host.last(a.id)), attempt(() => host.progress(a.id)).pipe(Effect.orElseSucceed(() => undefined))]);
		const why = p && stalled(p, Date.now());
		return { id: a.id, task: a.task.slice(0, 200), computer: a.computer ?? false, writer: a.writer ?? false, vm: a.vm ?? "own", box: a.box ?? `agent-${a.id}`, build: a.build ?? "?", ...(stale && { stale }), status: running ? "running" : "idle", started: new Date(a.started).toISOString(), ...(p && { lastProgress: new Date(p.at).toISOString() }), ...(why && { stalled: why }), last: last.length > SNIPPET ? `…${last.slice(-SNIPPET)}` : last };
	}), { concurrency: 5 });
});

/** Every subagent, newest first, for search: id, task, computer, started and status. */
export const catalog = (host: AgentHost) => Effect.gen(function* () {
	const known = [...(yield* kv.list<Info>("agentinfo:")).values()].sort((a, b) => b.started - a.started);
	return yield* Effect.forEach(known, (a) => attempt(() => host.running(a.id)).pipe(
		Effect.orElseSucceed(() => false),
		Effect.map((running) => ({ id: a.id, task: a.task.slice(0, 400), computer: a.computer ?? false, writer: a.writer ?? false, status: running ? "running" as const : "idle" as const, started: new Date(a.started).toISOString() })),
	), { concurrency: 10 });
});
