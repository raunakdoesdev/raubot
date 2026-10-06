import { Data, Effect } from "effect";
import Value from "typebox/value";
import { kv } from "./fx.ts";
import { SUBAGENT } from "./prompts.ts";

export class AgentError extends Data.TaggedError("AgentError")<{ message: string }> {}

/** What subagents need from the host: conversations it can create once, reopen after a restart, and steer or stop. */
export type AgentHost = {
	create(computer: boolean): Promise<number>;
	/** Submit a message (idempotent per requestId), wait for the run, return the last assistant text. */
	ask(id: number, content: string, requestId: string): Promise<string>;
	/** Whether a reply stops to ask for a confirmation the user doesn't need to give (anything but money or sharing data). */
	needless(reply: string): Promise<boolean>;
	running(id: number): Promise<boolean>;
	last(id: number): Promise<string>;
	steer(id: number, message: string): Promise<void>;
	stop(id: number): Promise<void>;
};

/** depth: raubot is 0, its subagents 1, theirs 2 (missing on old records: 1). parent: the conversation that started it. */
export type Info = { id: number; task: string; computer?: boolean; started: number; depth?: number; parent?: number };

/** How deep non-computer subagents may nest (raubot is depth 0). Computer agents are leaves: they never start agents, but any non-computer subagent may start one. */
export const MAX_DEPTH = 2;

/** Why `caller` (undefined: raubot) may not start a subagent, or undefined if it may. */
export const refuse = (caller: Info | undefined, computer: boolean) => {
	if (caller?.computer) return "A computer agent can't start subagents.";
	const depth = caller ? caller.depth ?? 1 : 0;
	if (!computer && depth + 1 > MAX_DEPTH) return `Subagents nest at most ${MAX_DEPTH} deep: start a computer agent or do it yourself.`;
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
export const agent = (host: AgentHost, key: string, { task, schema, computer = false }: { task: string; schema?: object; computer?: boolean }, from: { depth: number; parent?: number } = { depth: 1 }) => Effect.gen(function* () {
	let id = yield* kv.get<number>(key);
	if (!id) {
		id = yield* attempt(() => host.create(computer));
		yield* kv.put({ [key]: id, [`agentinfo:${id}`]: { id, task, computer, started: Date.now(), ...from } satisfies Info });
	}
	const ask = (content: string, n: string) => attempt(() => host.ask(id, content, `${key}:${n}`));
	const shape = schema ? `\n\nReply with only JSON (no prose, no code fence) matching this JSON Schema:\n${JSON.stringify(schema)}` : "";
	// The subagent's rules ride in its first message, after the view: its system prompt and tools stay byte-identical to raubot's, so the prefix is a cache hit.
	let reply = yield* ask(`<instructions>\n${SUBAGENT}\n</instructions>\n\nTask: ${task}${shape}`, "0");
	for (let k = 0; k < 5 && (yield* attempt(() => host.needless(reply))); k++) reply = yield* ask(APPROVED, `ok${k}`);
	if (!schema) return reply as unknown;
	for (let n = 1; ; n++) {
		const r = mismatch(schema, reply);
		if (!("err" in r)) return r.v;
		if (n > 2) return yield* new AgentError({ message: `Subagent reply doesn't match the schema: ${r.err}` });
		reply = yield* ask(`That reply doesn't match the schema (${r.err}). Reply again with only the JSON.${shape}`, String(n));
	}
});

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
	return yield* Effect.forEach(known.sort((a, b) => b.started - a.started).slice(0, LIST), (a) => Effect.gen(function* () {
		const [running, last] = yield* Effect.all([attempt(() => host.running(a.id)), attempt(() => host.last(a.id))]);
		return { id: a.id, task: a.task.slice(0, 200), computer: a.computer ?? false, status: running ? "running" : "idle", started: new Date(a.started).toISOString(), last: last.length > SNIPPET ? `…${last.slice(-SNIPPET)}` : last };
	}), { concurrency: 5 });
});

/** Every subagent, newest first, for search: id, task, computer, started and status. */
export const catalog = (host: AgentHost) => Effect.gen(function* () {
	const known = [...(yield* kv.list<Info>("agentinfo:")).values()].sort((a, b) => b.started - a.started);
	return yield* Effect.forEach(known, (a) => attempt(() => host.running(a.id)).pipe(
		Effect.orElseSucceed(() => false),
		Effect.map((running) => ({ id: a.id, task: a.task.slice(0, 400), computer: a.computer ?? false, status: running ? "running" as const : "idle" as const, started: new Date(a.started).toISOString() })),
	), { concurrency: 10 });
});
