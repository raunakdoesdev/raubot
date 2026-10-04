import { Data, Effect } from "effect";
import Value from "typebox/value";
import { kv } from "./fx.ts";

export class AgentError extends Data.TaggedError("AgentError")<{ message: string }> {}

/** What a subagent needs from the host: a conversation it can create once and reopen after a restart. */
export type AgentHost = {
	create(): Promise<number>;
	/** Submit a message (idempotent per requestId), wait for the run, return the last assistant text. */
	ask(id: number, content: string, requestId: string): Promise<string>;
};

const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => new AgentError({ message: String(e) }) });

const mismatch = (schema: object, reply: string) => {
	try {
		const v: unknown = JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, ""));
		if (Value.Check(schema, v)) return { v };
		return { err: [...Value.Errors(schema, v)].slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ") };
	} catch (e) { return { err: String(e) }; }
};

/** `tools.agent`: run a task on a subagent keyed by `key` (stable across restarts). A string reply, or with `schema` a validated value. */
export const agent = (host: AgentHost, key: string, { task, schema }: { task: string; schema?: object }) => Effect.gen(function* () {
	let id = yield* kv.get<number>(key);
	if (!id) {
		id = yield* attempt(() => host.create());
		yield* kv.put({ [key]: id });
	}
	const ask = (content: string, n: number) => attempt(() => host.ask(id, content, `${key}:${n}`));
	const shape = schema ? `\n\nReply with only JSON (no prose, no code fence) matching this JSON Schema:\n${JSON.stringify(schema)}` : "";
	let reply = yield* ask(`Task: ${task}${shape}`, 0);
	if (!schema) return reply as unknown;
	for (let n = 1; ; n++) {
		const r = mismatch(schema, reply);
		if (!("err" in r)) return r.v;
		if (n > 2) return yield* new AgentError({ message: `Subagent reply doesn't match the schema: ${r.err}` });
		reply = yield* ask(`That reply doesn't match the schema (${r.err}). Reply again with only the JSON.${shape}`, n);
	}
});
