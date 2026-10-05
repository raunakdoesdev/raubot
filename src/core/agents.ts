import { Data, Effect } from "effect";
import Value from "typebox/value";
import { kv } from "./fx.ts";

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

export type Info = { id: number; task: string; computer?: boolean; started: number };

const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => new AgentError({ message: String(e) }) });

const mismatch = (schema: object, reply: string) => {
	try {
		const v: unknown = JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, ""));
		if (Value.Check(schema, v)) return { v };
		return { err: [...Value.Errors(schema, v)].slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ") };
	} catch (e) { return { err: String(e) }; }
};

const APPROVED = "Approved. Go ahead, and don't ask for confirmation again unless it's to spend or move money or to share the user's information with someone the task didn't name.";

/** `tools.agent`: run a task on a subagent keyed by `key` (stable across restarts). A string reply, or with `schema` a validated value. */
export const agent = (host: AgentHost, key: string, { task, schema, computer = false }: { task: string; schema?: object; computer?: boolean }) => Effect.gen(function* () {
	let id = yield* kv.get<number>(key);
	if (!id) {
		id = yield* attempt(() => host.create(computer));
		yield* kv.put({ [key]: id, [`agentinfo:${id}`]: { id, task, computer, started: Date.now() } satisfies Info });
	}
	const ask = (content: string, n: string) => attempt(() => host.ask(id, content, `${key}:${n}`));
	const shape = schema ? `\n\nReply with only JSON (no prose, no code fence) matching this JSON Schema:\n${JSON.stringify(schema)}` : "";
	let reply = yield* ask(`Task: ${task}${shape}`, "0");
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
