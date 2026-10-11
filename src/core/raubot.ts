import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as C } from "@earendil-works/chord/context";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { Message } from "@earendil-works/pi-ai";
import {
	type Conversation, type ConversationView, createRegistry, type Extension, defineExtension, defineTool, GenerationTask, Harness,
	hook, section,
} from "@earendil-works/pi-durable";
import { configure, type EntryId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { Memory, type Msg } from "./memory.ts";
import { BROWSER, COMPACTIONS, COMPUTER, CRONS, DEVIN, EXECUTOR, HEARTBEATS, HIGH, MASTER, SELF, SETTLE, VIEW_DOC } from "./prompts.ts";
import { pieces } from "./pieces.ts";
export { pieces };
import { browse, responses, type Jar } from "./computer.ts";
import { DoSqlite } from "./sql.ts";
import type { Computer } from "./box.ts";
import { type App, codemode, describe, type Freezer, type Nested } from "./codemode.ts";
import { Mcp } from "./mcp.ts";
import { serve } from "../app/index.ts";
import type { AgentLine, AgentRow, Core, CoreEvent } from "./api.ts";
import { agent, agents, APPROVED, catalog, MAX_DEPTH, refuse, type AgentHost, type Info as AgentInfo } from "./agents.ts";
import { location } from "./channels/imessage.ts";
import { APP, type ChannelEnv, channelDoc, type Channels, channels, type Origin, acknowledge, idle, send as deliver, tag, uploadName, uploads } from "./channels/index.ts";
import * as frozen from "./freezer.ts";
import { bash, Box, BoxLive, runner, Storage, write } from "./fx.ts";
import * as files from "./files.ts";
import { MAX_BYTES, MAX_LINES } from "./files.ts";
import { JobHost, Jobs, JobsLive } from "./jobs.ts";
import { OAuth } from "./oauth.ts";
import { failedNote, redact, Secrets, SecretsLive } from "./secrets.ts";
import { type TraceEvent, Tracer } from "./trace.ts";
import * as cron from "./cron.ts";
import * as web from "./search.ts";
import * as devin from "./devin.ts";
import * as hb from "./heartbeat.ts";
import { finals } from "./replies.ts";

type Env = { SECRETS_KEY: string; PUBLIC_URL: string; RAUBOT: DurableObjectNamespace<Raubot>; BOX: DurableObjectNamespace<Computer>; ARTIFACTS: Artifacts; OPENAI_API_KEY: string; ANTHROPIC_API_KEY?: string; OPENROUTER_API_KEY?: string; PROVIDER: string; EXECUTOR_URL: string; MODEL: string; COMPACT_MODEL: string; AI: Ai } & ChannelEnv;

type Services = Storage | Box | Jobs | JobHost | Secrets;
type CronArgs = { add?: Partial<cron.Cron> & Pick<cron.Cron, "id" | "schedule" | "prompt">; remove?: string[]; run?: string };
type DevinArgs = { add?: { purpose: string; key?: string; session?: string }; link?: { key: string; session: string }; prompt?: string; close?: string[]; all?: boolean; check?: boolean; report?: string; error?: string };
type HeartbeatArgs = { every?: string; activeHours?: { start: string; end: string; tz?: string }; ackMaxChars?: number; target?: "last" | "app" | "imessage"; pause?: boolean; run?: boolean };
/** Buffered log line of a heartbeat turn, kept out of the log until the turn ends. */
type Held = { kind: Msg["kind"]; text: string; date: number };
/** The channel a turn's replies go to: `start` is the log index of its first message, `sent` the last reply delivered. */
type Reply = Origin & { start: number; sent?: number };
/** The heartbeat turn in flight: when it started, its due tasks and the digest cursor to commit if it succeeds. */
type Beat = { at: number; tasks: string[]; cursor?: unknown };
/** Messages from raubot's own machinery, not the user. */
const MACHINE = /^(\[via \w+\] )?\[(job \d+|secret \w+|cron [\w-]+|devin [\w-]+|heartbeat)[\] ]/;

const SOL = { provider: "openai", modelId: "gpt-6.1-sol" };

/** Clef questions for a subagent reply: is it stopping for a confirmation, and would that be one of the two the user wants? */
const CONFIRM = {
	asks: { type: "noul", instructions: "Does this message stop to ask for permission, approval or confirmation before going on with the task (as opposed to reporting a result, or asking for information it can't get)?" },
	about: { type: "choice", instructions: "What would the action it asks about do?", criteria: {
		money: "Spend or move money: buy, pay, order, subscribe, tip, donate or transfer funds",
		share: "Send data or information to other people: a message, email, DM, post, reply, share, upload to a third party, or an approval or answer given on the user's behalf",
		other: "Anything else: log in, solve a captcha, get past a browser blocker, accept cookies or terms, change a setting, delete something, download",
	} },
};

const text = (c: unknown) =>
	typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";

type Block = { cache_control?: unknown };
type AnthropicPayload = { system?: Block[] | string; tools?: Block[]; messages?: { role: string; content: Block[] | string }[] };

/** Anthropic marks: the system prompt (after tools, so it covers both), the view's last whole block, and pi's request-end mark. No 1h TTL. */
const WEB_SEARCH = { type: "openrouter:web_search", parameters: { max_results: 5 } } as unknown as Block;

export const markView = (mark: number) => (payload: unknown) => {
	const p = payload as AnthropicPayload;
	const first = p.messages?.find((m) => m.role === "user");
	if (mark < 0 || !first || typeof first.content === "string" || !first.content[mark]) return undefined;
	for (const b of p.tools ?? []) delete b.cache_control;
	const sys = Array.isArray(p.system) ? p.system : [];
	sys.forEach((b, k) => { if (k < sys.length - 1) delete b.cache_control; else b.cache_control = { type: "ephemeral" }; });
	for (const b of first.content) delete b.cache_control;
	first.content[mark].cache_control = { type: "ephemeral" };
	return p;
};

/** OpenRouter runs web search server-side; the model calls it like any tool. */
/** OpenRouter: server-side web search, and Anthropic first so every request of raubot and its subagents shares one prompt cache. */
const withSearch = (provider: string, p: AnthropicPayload) => (provider === "openrouter" ? { ...p, tools: [...(p.tools ?? []), WEB_SEARCH], provider: { order: ["anthropic"], allow_fallbacks: true } } : p);

export class Raubot extends DurableObject<Env> implements Core {
	memory!: Memory;
	tracer!: Tracer;
	oauth!: OAuth;
	harness!: Harness;
	root!: Conversation;
	state!: AttachedReplicatedState<ConversationView>;
	#listeners = new Set<(e: CoreEvent) => void>();
	#lock: Promise<unknown> = Promise.resolve();
	#partial = "";
	#steering = "[]";
	#delivering = false;
	#redeliver = false;
	#marks = -1;
	#compact: { system: string; tools: { name: string; description: string; parameters: never }[] } | undefined;
	#prompt = "";
	#fx!: <A, E>(e: Effect.Effect<A, E, Services>) => Promise<A>;
	#channels!: Channels;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => this.#init());
	}

	/** Executor: its `skills` and `resume` as plain tools, and every app tool mounted on `tools` (one `execute` per call). Schemas cached so the prompt stays byte-stable. */
	async #executor(): Promise<{ nested: Nested[]; app?: App }> {
		if (!(await this.oauth.connected())) return { nested: [] };
		const mcp = new Mcp(this.env.EXECUTOR_URL, (force) => this.oauth.token(force));
		let list = await this.ctx.storage.get<Awaited<ReturnType<Mcp["tools"]>>>("executor-tools");
		if (!list) {
			try { list = await mcp.tools(); await this.ctx.storage.put("executor-tools", list); }
			catch (e) { console.error("executor", e); return { nested: [] }; }
		}
		const nested = list.filter((t) => t.name !== "execute").map((t) => ({
			name: t.name, description: (t.description ?? t.name).replace(/paused execute program/g, "paused app call").replace(/namespaces used by execute/g, "namespaces on `tools`"), inputSchema: t.inputSchema,
			execute: (args: Record<string, unknown>) => mcp.call(t.name, args),
		}));
		const ref = (path: string[]) => path.map((k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join("");
		const app: App = async (path, args) => {
			const out = await mcp.call("execute", { code: `return await tools${ref(path)}(${JSON.stringify(args ?? {})});` });
			const r = JSON.parse(out);
			if (r.status !== "completed") return out; // paused for approval: the agent shows it and resumes
			const v = r.execution?.value;
			if (!r.execution?.ok || v?.isError) throw new Error(JSON.stringify(r.execution?.error ?? v));
			const res = v?.structuredContent?.result ?? v?.structuredContent ?? v?.content?.map((c: { text?: string }) => c.text).join("\n") ?? v;
			return typeof res === "string" ? res : JSON.stringify(res);
		};
		return { nested, app };
	}

	async #init() {
		this.oauth = new OAuth(this.ctx.storage, this.env.EXECUTOR_URL);
		this.#channels = channels(this.env);
		// Live traces: only raubot's own scripts and its jobs stream to the main chat; a subagent's view polls /traces.json.
		this.tracer = new Tracer(this.ctx.storage, (e) => { if (this.#mine(e.run.conv)) this.#broadcast({ trace: e } as CoreEvent & { trace: TraceEvent }); });
		const host = Layer.succeed(JobHost, {
			run: async (job, signal) => {
				const store = (await this.ctx.storage.get<Record<string, unknown>>("codemode-store")) ?? {};
				const freezer = this.#freezer(`job:${job.id}`);
				const t = this.tracer.begin(`job:${job.id}`, job.code, job.id);
				let r;
				try { r = await codemode(job.code, this.#tools(`job:${job.id}`, undefined, job.by), store, signal, this.#app, freezer, job.deadline, t.hooks); }
				finally { t.end(r?.error !== false); }
				await freezer.clear();
				return r;
			},
			bump: (from, text, by) => this.#bump(from, text, by),
			note: (job, text) => this.#fx(cron.record(job.label.replace(/^cron /, ""), /^"?(SENT|SKIPPED|SILENT)/.exec(text)?.[1]?.toLowerCase() ?? "done")),
			stopChildren: async (id) => {
				for (const c of (await this.ctx.storage.list<number>({ prefix: `agent:job:${id}:` })).values()) await (await this.harness.conversation(c as never, C))?.abort(C);
			},
		});
		const base = Layer.mergeAll(Layer.succeed(Storage, this.ctx.storage), BoxLive(this.env.BOX), host);
		this.#fx = runner(ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(JobsLive, base), Layer.provide(SecretsLive(this.env.SECRETS_KEY), base))));
		const models = createModels({ authContext: { env: async (n) => (this.env as unknown as Record<string, string>)[n], fileExists: async () => false } });
		models.setProvider(openaiProvider());
		models.setProvider(anthropicProvider());
		models.setProvider(openrouterProvider());
		const stream = models.streamSimple.bind(models);
		models.streamSimple = (model, context, options) =>
			// One session id for raubot and its subagents: OpenRouter routes by it, so a new subagent lands on the provider that holds raubot's cached prefix.
stream(model, context, model.api === "anthropic-messages" ? { ...options, sessionId: `raubot-${this.ctx.id}`, onPayload: (p: unknown) => withSearch(model.provider, markView(this.#marks)(p) ?? (p as AnthropicPayload)) }
				: model.api === "openai-responses" ? { ...options, onPayload: responses } : options);
		const compactor = models.getModel("openrouter", this.env.COMPACT_MODEL)!;
		// A compaction is a call like a turn: same system prompt and tools (never called), then its <chat> view and its task (OptChat).
		this.memory = new Memory(this.ctx.storage.sql, async (chat, turns, started) => {
			const t0 = Date.now();
			const c = this.#compact;
			if (!c) throw new Error("compactor not ready");
			const now = Date.now();
			const messages = turns.map((t, k) => t.role === "user"
				? { role: "user" as const, content: k === 0 ? [{ type: "text" as const, text: chat }, { type: "text" as const, text: t.text }] : t.text, timestamp: now }
				: { role: "assistant" as const, content: [{ type: "text" as const, text: t.text }], api: compactor.api, provider: compactor.provider, model: compactor.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: now });
			const s = models.streamSimple(compactor, { systemPrompt: c.system, tools: c.tools, messages } as never, {
				reasoning: "low", signal: AbortSignal.timeout(30_000),
				// Fastest provider first, and fall back to Luna when GLM errors or is rate-limited. Tools are there for the cache only.
				onPayload: (p: unknown) => ({ ...(p as object), tool_choice: "none", provider: { sort: "latency" }, models: [this.env.COMPACT_MODEL, "openai/gpt-6-luna"] }),
			});
			for await (const e of s) { started(); if (e.type === "done" || e.type === "error") break; }
			const r = await s.result();
			console.log("compact call", JSON.stringify({ ms: Date.now() - t0, bytes: chat.length, tries: (turns.length + 1) / 2, stop: r.stopReason, ...r.usage, cost: r.usage.cost?.total }));
			if (r.stopReason === "error" || r.stopReason === "aborted") throw new Error(r.errorMessage ?? r.stopReason);
			return text(r.content);
		}, () => this.#changed());

		const memory = this.memory;
		const executor = await this.#executor();
		// bash/read/edit/write run in the caller's box: raubot's ("main") or a subagent's own ("agent-<id>").
		const ns = this.env.BOX;
		const boxTools = (box: string): Nested[] => [
			{
				name: "bash",
				description: "Run a bash command in your Linux box (cwd /workspace). Pass the command as cmd (or command, as in pi). Output is combined stdout+stderr with the exit code, cut in the middle past 30k chars. Default timeout 120s, max 900s. Your secrets are env vars in every command. To read, change or create files, prefer tools.read/edit/write over cat, sed and heredocs.",
				inputSchema: Type.Object({ cmd: Type.Optional(Type.String()), command: Type.Optional(Type.String()), timeout: Type.Optional(Type.Integer()) }),
				execute: ({ cmd, command, timeout }: { cmd?: string; command?: string; timeout?: number }) => this.#fx(Effect.gen(function* () {
					const c = cmd ?? command;
					if (typeof c !== "string") return yield* Effect.fail(new Error("bash needs cmd (or command)"));
					const env = yield* Effect.flatMap(Secrets, (s) => s.env());
					return redact(env, yield* bash(c, Math.min(timeout ?? 120, 900), env)) + failedNote(env);
				}).pipe(Effect.provide(BoxLive(ns, box)))),
			},
			{
				name: "read",
				description: `Read a file in your box (path absolute, or relative to /workspace). Text comes back as "N<tab>line" rows, at most ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB per call; then a hint gives the offset to continue. offset is the 1-indexed first line, limit the line count. Images (png, jpeg, gif, webp) come back as { type: "image", mimeType, data, image_url, path, size, dims }, shrunk to 2000px if bigger: pass it to image(...) to look at it.`,
				inputSchema: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer()), limit: Type.Optional(Type.Integer()) }),
				execute: (args: { path: string; offset?: number; limit?: number }) => this.#fx(Effect.gen(function* () {
					const env = yield* Effect.flatMap(Secrets, (s) => s.env());
					const box = yield* Box;
					const r = yield* Effect.tryPromise({ try: () => files.read((c, i, t) => Effect.runPromise(box.exec(c, i, t)), args), catch: (e) => e as Error });
					return typeof r === "string" ? redact(env, r) : r;
				}).pipe(Effect.provide(BoxLive(ns, box)))),
			},
			{
				name: "edit",
				description: "Edit a file in your box with exact-text replacements: edits: [{ oldText, newText }]. Each oldText must match the original file exactly (whitespace and newlines too) and be unique in it; edits must not overlap. Fails, changing nothing, if one is missing or not unique. Keeps the file's line endings and BOM. Returns a line-numbered diff.",
				inputSchema: Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) }),
				execute: (args: { path: string; edits: { oldText: string; newText: string }[] }) => this.#fx(Effect.gen(function* () {
					const box = yield* Box;
					return yield* Effect.tryPromise({ try: () => files.edit((c, i, t) => Effect.runPromise(box.exec(c, i, t)), (p, b) => Effect.runPromise(box.write(p, b)), args), catch: (e) => e as Error });
				}).pipe(Effect.provide(BoxLive(ns, box)))),
			},
			{
				name: "write",
				description: "Write a file in your box (path absolute, or relative to /workspace), creating parent directories and overwriting it. content is the full text. Use edit for changes to an existing file.",
				inputSchema: Type.Object({ path: Type.String(), content: Type.String() }),
				execute: (args: { path: string; content: string }) => this.#fx(Effect.gen(function* () {
					const box = yield* Box;
					return yield* Effect.tryPromise({ try: () => files.write((p, b) => Effect.runPromise(box.write(p, b)), args), catch: (e) => e as Error });
				}).pipe(Effect.provide(BoxLive(ns, box)))),
			},
		];
		const nested: Nested[] = [
			...boxTools("main"),
			{
				name: "secrets",
				description: `Your secrets (API keys, tokens, passwords): [{ name, why, set, expires }]. You never see values: each one is an env var ($NAME) in every tools.bash command, and any value printed comes back as [secret NAME]. Use them in place (curl -H "Authorization: Bearer $GITHUB_TOKEN" ...); never write them to files in /workspace, which is pushed to git.
\`ask: { name, why }\` asks the user for one (name like GITHUB_TOKEN; why is one line shown to them). They get a form to paste it in, and you get a "[secret NAME saved]" message when it's set, so don't wait for it: end your turn. Never ask the user to paste a secret into chat. \`remove: [names]\` deletes secrets.`,
				inputSchema: Type.Object({ ask: Type.Optional(Type.Object({ name: Type.String(), why: Type.String() })), remove: Type.Optional(Type.Array(Type.String())) }),
				execute: (args: { ask?: { name: string; why: string }; remove?: string[] }) => this.#secrets(args),
			},
			{
				name: "zoom",
				description: "Look closer at messages id..id+n-1: n>1 gives the two half summaries, n=1 the full original message.",
				inputSchema: Type.Object({ id: Type.Integer(), n: Type.Integer() }),
				execute: async ({ id, n }: { id: number; n: number }) => memory.zoom(id, n),
			},
			{
				name: "date",
				description: "When message id was logged.",
				inputSchema: Type.Object({ id: Type.Integer() }),
				execute: async ({ id }: { id: number }) => memory.date(id),
			},
			{
				name: "location",
				description: "Where the user is now, from the Find My location they share with your iMessage number: { latitude?, longitude?, address?, locationType (live | shallow | legacy | unknown), locationTimestamp?, ... }. Coordinates can be missing. Fails if they aren't sharing it.",
				inputSchema: Type.Object({}),
				execute: async () => this.#fx(location((await this.#origin("imessage")).to)),
			},
			{
				name: "decide",
				description: `Decision API: a very cheap, fast model (Cloudflare Clef) that reads a state and answers typed questions with probabilities, no prose. Use it to triage, filter or score lots of data (messages, records, logs, pages) instead of reading it all yourself: call it once per item, in parallel.
state: text or JSON (up to ~64k tokens). questions: map of id to
  { type: "noul", instructions } -> { noul: P(yes) }
  { type: "choice", instructions, criteria: { option: description | null, ... } } -> { choice, probabilities, confidence }
  { type: "score", instructions, criteria: [lowest level, ..., highest] } -> { score, probabilities, confidence }
model: "clef-flash" (default, 9B, fastest) or "clef" (27B, more accurate). Returns { answers } keyed by question id.
Example: find the Slack messages that need the user's attention.
  // msgs: an array you fetched, e.g. Slack messages from an Executor app
  const r = await Promise.all(msgs.map((m) => tools.decide({ state: m, questions: { act: { type: "noul", instructions: "Does this need the user to reply or act?" } } })));
  return msgs.filter((m, i) => r[i].answers.act.noul > 0.7);`,
				inputSchema: Type.Object({ state: Type.Unknown(), questions: Type.Record(Type.String(), Type.Unknown()), model: Type.Optional(Type.String()) }),
				execute: async ({ state, questions, model = "clef-flash" }: { state: unknown; questions: Record<string, unknown>; model?: string }) =>
					JSON.stringify(await this.env.AI.run(`@cf/cloudflare/${model}` as keyof AiModels, { model, state, questions } as never)),
			},
			{
				name: "web_search",
				description: web.DESCRIPTION,
				inputSchema: Type.Object({ query: Type.String(), max_results: Type.Optional(Type.Integer()) }),
				execute: ({ query, max_results }: { query: string; max_results?: number }) => web.search(this.env.OPENROUTER_API_KEY, query, max_results),
			},
			{
				name: "openrouter_web_search",
				description: "Alias of web_search.",
				inputSchema: Type.Object({ query: Type.String(), max_results: Type.Optional(Type.Integer()) }),
				execute: ({ query, max_results }: { query: string; max_results?: number }) => web.search(this.env.OPENROUTER_API_KEY, query, max_results),
			},
			...executor.nested,
		];
		const messageDoc: Nested = {
			name: "message",
			description: "Send the user a message yourself, without waiting to be asked (to answer the current message, just reply). channel: \"imessage\" (default) or \"app\". files: box paths sent as attachments (any type). Put links in text as bare URLs. Over iMessage write plain text, no markdown. For crons, alerts and results the user needs now; don't text for things that can wait.",
			inputSchema: Type.Object({ text: Type.String(), channel: Type.Optional(Type.String()), files: Type.Optional(Type.Array(Type.String())) }),
			execute: () => Promise.reject(new Error("unbound")),
		};
		const cronsDoc: Nested = {
			name: "crons",
			description: `Your scheduled prompts, kept across restarts: [{ id, schedule, tz, prompt, mode, channel, unless, timeout, enabled, next, last }]. No args lists them.
		\`add: { id, schedule, prompt, tz?, mode?, channel?, unless?, script?, timeout?, enabled? }\` creates or replaces one. schedule: 5-field cron "min hour dom mon dow" (e.g. "0 8 * * 1-5" = 8:00 on weekdays) in tz (default ${cron.TZ}), or an ISO time for a one-shot. mode "agent" (default): a fresh subagent runs the prompt (it sees your VIEW and has your tools) and its final reply goes to channel ("imessage" default, or "app"); a reply of NO_REPLY or HEARTBEAT_OK sends nothing. mode "turn": the prompt comes to you as a "[cron <id>]" message and your reply goes to channel. unless: a bash test run first; exit 0 skips the run ({date} is today in tz, e.g. "test -f /workspace/briefings/{date}.sent"; {date} works in prompt too). script: box path of a codemode script (agent mode) run first with NOW (local ISO time) set; what it returns is added to the task, for deterministic data collection. timeout: seconds (default 3600).
		\`remove: [ids]\` deletes some; \`run: id\` runs one now.`,
			inputSchema: Type.Object({
				add: Type.Optional(Type.Object({ id: Type.String(), schedule: Type.String(), prompt: Type.String(), tz: Type.Optional(Type.String()), mode: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("turn")])), channel: Type.Optional(Type.String()), unless: Type.Optional(Type.String()), script: Type.Optional(Type.String()), timeout: Type.Optional(Type.Integer()), enabled: Type.Optional(Type.Boolean()) })),
				remove: Type.Optional(Type.Array(Type.String())),
				run: Type.Optional(Type.String()),
			}),
			execute: (args: CronArgs) => this.#crons(args),
		};
		nested.push(messageDoc, cronsDoc, {
			name: "heartbeat",
			description: `Your heartbeat (see Heartbeats): no args shows its config and state { every, activeHours, ackMaxChars, target, paused, lastFire, nextDue, last, tasks }. Set every (e.g. "30m", "2h"), activeHours { start: "07:00", end: "23:00", tz? }, ackMaxChars, target ("last", "app" or "imessage"), pause (true/false). run: true fires one heartbeat as soon as you're idle (ignores active hours and pause).`,
			inputSchema: Type.Object({
				every: Type.Optional(Type.String()), activeHours: Type.Optional(Type.Object({ start: Type.String(), end: Type.String(), tz: Type.Optional(Type.String()) })),
				ackMaxChars: Type.Optional(Type.Integer()), target: Type.Optional(Type.Union([Type.Literal("last"), Type.Literal("app"), Type.Literal("imessage")])),
				pause: Type.Optional(Type.Boolean()), run: Type.Optional(Type.Boolean()),
			}),
			execute: (args: HeartbeatArgs) => this.#heartbeat(args),
		}, {
			name: "devin_runs",
			description: `Registry of Devin sessions you started, with signed callbacks: use it instead of waiting on devin_session_gather. No args lists open runs.
\`add: { purpose, key?, session? }\` registers a run before you create the session and returns { key, prompt, curl }: append prompt to the Devin session's prompt (it holds a signed curl Devin runs when it finishes or gets blocked). \`link: { key, session }\` records the Devin session id after creating it. \`prompt: key or session id\` gives an open run's lines again (e.g. to message a running session the devin_image upload helper). \`close: [key or session id]\` closes runs; \`all: true\` lists closed ones too; \`check: true\` runs the safety-net check now.
A valid callback comes to you as a "[devin <id> done|blocked|failed]" message with Devin's summary. Every hour a safety net reads each open run's Devin status: finished-without-callback, blocked (waiting for user) and stuck (>24h) runs come the same way; finished ones close. Screenshots the session uploaded with devin_image come attached to that message as "[attached: uploads/devin/...]" lines.`,
			inputSchema: Type.Object({
				add: Type.Optional(Type.Object({ purpose: Type.String(), key: Type.Optional(Type.String()), session: Type.Optional(Type.String()) })),
				link: Type.Optional(Type.Object({ key: Type.String(), session: Type.String() })),
				prompt: Type.Optional(Type.String({ description: "Run key or session id: gives its prompt lines (devin_done + devin_image) again." })),
				close: Type.Optional(Type.Array(Type.String())),
				all: Type.Optional(Type.Boolean()), check: Type.Optional(Type.Boolean()),
				report: Type.Optional(Type.String({ description: "Internal: the safety net's devin_session_interact get output." })),
				error: Type.Optional(Type.String({ description: "Internal: the safety net's error." })),
			}),
			execute: (args: DevinArgs) => this.#devin(args),
		});
		const agentDoc: Nested = {
			name: "agent",
			description: `Start a subagent on a task and get its result. It runs on your model with all your tools, sees your current VIEW as context, and does only the task. Its work stays out of your memory. Run several with Promise.all.
Each subagent has its own box, copied from your box's last snapshot (same files and installs), so they never collide. Its /workspace commits merge into workspace main when it replies, and show up in your /workspace on your next bash call; a conflict it can't fix stays on branch agent-<id>.
With no schema it resolves to its reply as a string. With schema (a JSON Schema) it resolves to a parsed object matching it, for use in code.
With computer: true it runs on GPT-6.1 Sol with a browser too: a real Chromium in its own box whose logins are shared with every box (a login or logout in one shows up in the others on their next browser call) and signs in with the user's Bitwarden passwords, TOTP codes and passkeys. Use it for anything done on a website.  A browser task takes minutes, longer than a foreground script may run, so start it in a background codemode job (timeout 1800) and steer or check it with tools.agents.
Nesting: a computer agent can't start agents; other subagents can start computer agents, and non-computer subagents nest at most ${MAX_DEPTH} deep (you are depth 0).
Example: const r = await tools.agent({ task: "Find every open PR in repo X that touches billing", schema: { type: "array", items: { type: "object", properties: { url: { type: "string" }, why: { type: "string" } }, required: ["url", "why"] } } });`,
			inputSchema: Type.Object({ task: Type.String(), schema: Type.Optional(Type.Unknown()), computer: Type.Optional(Type.Boolean()) }),
			execute: () => Promise.reject(new Error("unbound")),
		};
		const agentsDoc: Nested = {
			name: "agents",
			description: `Your subagents, newest first: [{ id, task, computer, status: "running" | "idle", started, last }], last being the end of its latest output. Works across turns and from background jobs.
\`send: { id, message }\` talks to one: a running subagent reads it at its next step (resolves at once); an idle one answers it as a follow-up and this resolves to its reply. \`stop: [ids]\` stops running ones.`,
			inputSchema: Type.Object({ send: Type.Optional(Type.Object({ id: Type.Integer(), message: Type.String() })), stop: Type.Optional(Type.Array(Type.Integer())) }),
			execute: () => Promise.reject(new Error("unbound")),
		};
		const system = `${MASTER}\n${channelDoc(this.#channels)}\n\n${VIEW_DOC}\n\n${SELF}\n\n${CRONS}\n\n${HEARTBEATS}\n\n${DEVIN}${executor.app ? `\n\n${EXECUTOR}` : ""}\n\n${COMPACTIONS}`;
		nested.push(agentDoc, agentsDoc, {
			name: "jobs",
			description: "Your background jobs, newest first: { id, label, status, started, ended, deadline }. `cancel: [ids]` stops running ones (no result comes back); `prune: true` forgets finished ones.",
			inputSchema: Type.Object({ cancel: Type.Optional(Type.Array(Type.Integer())), prune: Type.Optional(Type.Boolean()) }),
			execute: ({ cancel = [], prune }: { cancel?: number[]; prune?: boolean }) => this.#fx(Effect.gen(function* () {
				const jobs = yield* Jobs;
				yield* Effect.forEach(cancel, jobs.cancel);
				if (prune) yield* jobs.prune();
				return (yield* jobs.list()).reverse().map(({ code: _, from: __, ...j }) => j);
			})),
		});
		const boxed = new Map<string, Map<string, Nested>>();
		this.#tools = (scope, owner, by) => {
			const caller = owner?.api.conversationId ?? by ?? this.root.id;
			const box = owner ? this.#boxOf(owner.api.conversationId) : "main";
			const own = box === "main" ? undefined : boxed.get(box) ?? boxed.set(box, new Map(boxTools(box).map((t) => [t.name, t]))).get(box)!;
			return nested.map((t) => (t === agentDoc ? { ...t, execute: this.#agent(scope, caller, owner) } : t === agentsDoc ? { ...t, execute: this.#agents() } 
				: t === messageDoc ? { ...t, execute: this.#message(owner?.api.conversationId === this.root.id) } : own?.get(t.name) ?? t));
		};
		this.#app = executor.app;
		this.#prompt = `# System prompt\n\n${system}\n\n# codemode tool description\n\n${describe(nested)}\n`;
		const registry = createRegistry();
		const fx = this.#fx;
		this.#computer = defineExtension({
			name: "computer",
			sections: [section("computer", () => COMPUTER, { tag: false })],
			tools: [defineTool({
				name: "browser", replay: "unsafe", description: BROWSER,
				parameters: Type.Object({ code: Type.String({ description: "JavaScript, run as an async function body." }), timeout: Type.Optional(Type.Integer({ description: "Seconds, default 60, max 600." })) }),
				execute: async ({ code, timeout }, api) => {
					const env = await fx(Effect.flatMap(Secrets, (s) => s.env()));
					const main = ns.getByName("main");
					const jar = (await main.jar()) as Jar;
					const r = await fx(browse(code, Math.min(timeout ?? 60, 600), env, jar).pipe(Effect.provide(BoxLive(ns, this.#boxOf(api.conversationId)))));
					if (r.changed && Object.keys(r.changed).length) await main.jarPut(r.changed);
					console.log("browser jar", JSON.stringify({ box: this.#boxOf(api.conversationId), jar: Object.keys(jar).length, changed: Object.keys(r.changed ?? {}) }));
					return {
						content: [{ type: "text", text: redact(env, `${r.out || "(no output)"}\n\ntabs (* is page):\n${r.tabs}`) + failedNote(env) }, ...r.images.map((data) => ({ type: "image" as const, mimeType: "image/jpeg", data }))],
						isError: r.error,
					};
				},
			})],
		});
		registry.install(this.#computer);
		const codemodeParams = Type.Object({
			code: Type.String({ description: "Raw JavaScript source." }),
			background: Type.Optional(Type.Object({ label: Type.String(), timeout: Type.Integer({ description: "Seconds, max 86400." }) })),
		});
		this.#compact = { system, tools: [{ name: "codemode", description: describe(nested), parameters: codemodeParams as never }] };
		const raubot = defineExtension({
			name: "raubot",
			sections: [section("raubot", () => system, { tag: false })],
			tools: [defineTool({
				name: "codemode", replay: "safe", description: describe(nested),
				parameters: codemodeParams,
				execute: async ({ code, background }, api, ctx) => {
					if (background) {
						// A subagent's job (e.g. a cron run waiting on a computer agent) reports back to it while it runs, else to raubot.
						const by = api.conversationId === this.root.id ? undefined : api.conversationId as unknown as number;
						const from = (await this.ctx.storage.get<Origin>("reply")) ?? APP;
						const { label, timeout } = background;
						const job = await this.#fx(Effect.flatMap(Jobs, (j) => j.start(code, label, timeout, { channel: from.channel, to: from.to }, false, by)));
						return { content: [{ type: "text", text: `Started job ${job.id} (${label}). Its result will come back to you as a job message.` }] };
					}
					const store = (await this.ctx.storage.get<Record<string, unknown>>("codemode-store")) ?? {};
					const tools = this.#tools(String(api.taskId), { api, ctx });
					const freezer = this.#freezer(String(api.taskId));
					const t = this.tracer.begin(String(api.conversationId), code);
					let r;
					try { r = await codemode(code, tools, store, (ctx as { signal?: AbortSignal }).signal, executor.app, freezer, undefined, t.hooks); }
					finally { t.end(r?.error !== false); }
					await freezer.clear();
					if (!r.error) await this.ctx.storage.put("codemode-store", store);
					return { content: [{ type: "text" as const, text: r.text }, ...(r.images ?? []).map((i) => ({ type: "image" as const, ...i }))], isError: r.error };
				},
			})],
			hooks: [hook(GenerationTask, {
				// Each run starts from a reset, so the request is [first user message, ...this run]; prefix it with the view pinned at run start.
				beforeRequest: ({ messages }) => {
					const at = messages.findIndex((m) => m.role === "user");
					if (at < 0) return undefined;
					const first = messages[at] as Extract<Message, { role: "user" }>;
					const body = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
					const { out, mark } = pieces(memory.get("pinned") ?? "");
					this.#marks = mark;
					return { messages: messages.with(at, { ...first, content: [...out.map((text) => ({ type: "text" as const, text })), ...body] }) };
				},
			})],
		});
		registry.install(raubot);

		const storage = await SqliteStorage.open(new DoSqlite(this.ctx.storage));
		this.harness = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false }, steeringMode: "all", extensions: [raubot] } }, C);
		this.root = await this.harness.root(C, {
			agent: { model: { provider: this.env.PROVIDER, modelId: this.env.MODEL }, thinkingLevel: "medium" },
		});
		this.state = await this.root.viewState(C);
		this.state.subscribe(async (view) => {
			const msg = (view.docs["pi.live"] as { generation?: { message?: { content?: unknown } } } | undefined)?.generation?.message;
			const partial = msg ? text(msg.content) : "";
			if (partial !== this.#partial) this.#broadcast({ partial: (this.#partial = partial) });
			const steering = JSON.stringify(this.#steers(view.docs));
			if (steering !== this.#steering) this.#broadcast({ steering: JSON.parse((this.#steering = steering)) });
			await this.#sync();
			void this.#deliver().catch((e) => console.error("deliver", e));
		});
		this.harness.resume();
		await this.#fx(Effect.flatMap(Jobs, (j) => j.resume()));
		await this.#seed();
		await this.#sync();
		this.memory.pump();
		this.#changed();
		await this.#arm();
		void this.#drain().catch((e) => console.error("drain", e));
	}

	#serial<T>(op: () => Promise<T>): Promise<T> {
		const next = this.#lock.then(op, op);
		this.#lock = next.catch(() => {});
		return next;
	}

	/** Flatten new pi transcript entries into the memory log (thoughts dropped). */
	#sync() {
		return this.#serial(async () => {
			const saved = this.memory.get("entry");
			const last = saved === undefined ? undefined : Number(saved) as EntryId;
			const fresh = [];
			let cursor;
			do {
				const page = await this.root.entries(last === undefined ? {} : { minEntryId: last }, 200, cursor, C);
				fresh.push(...page.items);
				cursor = page.next;
			} while (cursor);
			const beat = await this.ctx.storage.get<Beat>("hb-turn");
			const held: Held[] = beat ? JSON.parse(this.memory.get("hb-held") ?? "[]") : [];
			const log = (kind: Msg["kind"], body: string, date: number) => (beat ? void (body.trim() && held.push({ kind, text: body, date })) : this.#log(kind, body, date));
			for (const e of fresh.filter((e) => e.id !== last).reverse()) {
				for (const m of e.model ?? []) {
					const date = m.timestamp ?? Date.now();
					if (m.role === "assistant" && m.usage) this.#usage({ date, ...m.usage });
					if (m.role === "user") { const t = text(m.content); log(/^(\[via \w+\] )?\[devin [\w-]+ /.test(t) ? "devin" : /^(\[via \w+\] )?\[(job \d+|secret \w+|cron [\w-]+|heartbeat)[\] ]/.test(t) ? "job" : "user", t, date); }
					else if (m.role === "toolResult") log("echo", `${m.toolName}: ${text(m.content)}`, date);
					else for (const b of m.content) {
						if (typeof b === "string") continue;
						if (b.type === "text") log("talk", b.text, date);
						else if (b.type === "toolCall") log("tool", `${b.name} ${JSON.stringify(b.arguments)}`, date);
					}
				}
				this.memory.set("entry", String(e.id));
				}
				if (beat) { this.memory.set("hb-held", JSON.stringify(held)); await this.#settleBeat(beat, held); }
		});
	}

	#log(kind: Msg["kind"], body: string, date: number) {
		if (!body.trim()) return;
		this.memory.append(kind, body, date);
		this.#broadcast({ history: this.memory.log.slice(-1) });
	}

	#usage(u: { date: number; input: number; output: number; cacheRead: number; cacheWrite: number }) {
		console.log("usage", JSON.stringify(u));
		const all = JSON.parse(this.memory.get("usage") ?? "[]") as object[];
		const { date, input, output, cacheRead, cacheWrite } = u;
		this.memory.set("usage", JSON.stringify([...all, { date, input, output, cacheRead, cacheWrite }].slice(-50)));
	}

	tree(q: URLSearchParams) {
		const m = this.memory, T = m.log.length;
		// How the model sees a node: as a view line, folded into a bigger view line, or opened up into finer lines.
		const seen = (l: number, i: number) => {
			const a = i << l, b = (i + 1) << l;
			const hit = m.view.filter(([vl, vi]) => vi << vl < b && (vi + 1) << vl > a);
			return hit.some(([vl]) => vl === l) ? "view" : hit.some(([vl]) => vl > l) ? "folded" : "open";
		};
		const part = (l: number, i: number) => {
			const a = i << l, b = Math.min((i + 1) << l, T) - 1;
			return { l, i, id: a, n: 1 << l, text: m.node(l, i) ?? null, from: m.log[a]?.date, to: m.log[b]?.date, kind: l ? undefined : m.log[a]?.kind, seen: seen(l, i) };
		};
		if (q.has("find")) {
			const s = q.get("find")!.toLowerCase(), hits = [];
			for (let i = T - 1; i >= 0 && hits.length < 50; i--) {
				const x = m.log[i], k = x.text.toLowerCase().indexOf(s);
				if (s && k >= 0) hits.push({ id: i, kind: x.kind, date: x.date, snippet: x.text.slice(Math.max(0, k - 60), k + 140) });
			}
			return { hits };
		}
		if (q.has("l")) {
			const l = Number(q.get("l")), i = Number(q.get("i"));
			if (l === 0) { const x = m.log[i]!; return { raw: x.text, kind: x.kind, date: x.date }; }
			return { children: [part(l - 1, 2 * i), part(l - 1, 2 * i + 1)].filter((c) => c.id < T) };
		}
		// The complete subtrees that tile the log, biggest (oldest) first.
		const roots = [];
		for (let l = 31, a = 0; l >= 0; l--) if (T & (1 << l)) { roots.push(part(l, a >> l)); a += 1 << l; }
		return {
			log: T, pending: m.pending(), bytes: new TextEncoder().encode(m.render()).length, budget: HIGH,
			roots, view: m.view.map(([l, i]) => part(l, i)), usage: JSON.parse(m.get("usage") ?? "[]"),
		};
	}

	/** Final replies go back to the channel that started the turn: every reply the model finished before a newer message joined the turn, then the turn's last one. Stored, so a restart mid-turn still delivers; `sent` keeps them in order and never twice. */
	async #deliver() {
		if (this.#delivering) return void (this.#redeliver = true);
		this.#delivering = true;
		try {
			do {
				this.#redeliver = false;
				const r = await this.ctx.storage.get<Reply>("reply");
				if (!r) return;
				const busy = this.busy();
				const replies = finals(this.memory.log, r.start, r.sent ?? -1, !busy);
				for (const { at, text: said } of replies) {
					const reply = !cron.SILENT.test(said) ? hb.scrub(said) || undefined : undefined;
					await this.ctx.storage.put("reply", { ...r, sent: at }); // at most once, even across a restart
					if (reply) await this.#fx(deliver(this.#channels, r, reply)).catch((e) => console.error("deliver", e));
				}
				if (!busy && (replies.length || this.memory.log.length > r.start + 1)) {
					await this.ctx.storage.delete("reply");
					if (!replies.length) await this.#fx(idle(this.#channels, r)); // ended silent (or already sent)
				}
			} while (this.#redeliver);
		} finally { this.#delivering = false; }
	}

	/** Promise view of the freezer for codemode; saves are queued so an older image never lands after a newer one. */
	#freezer(task: string): Freezer & { clear(): Promise<void> } {
		const key = `frozen:${task}`;
		let chain = Promise.resolve();
		return {
			load: () => this.#fx(frozen.load(key)),
			save: (f) => (chain = chain.then(() => this.#fx(frozen.save(key, f))).catch((e) => console.error("freeze", e))),
			clear: async () => { await chain; await this.#fx(frozen.clear(key)); },
		};
	}

	/** Subagents: a foreground call owns its children (Esc stops them); a background job's are ownerless. Computer ones run on GPT-6.1 Sol with the browser. */
	#host(owner?: { api: ToolExecutionApi; ctx: Context }): AgentHost {
		const ctx = owner?.ctx ?? C;
		const conv = async (id: number) => (await this.harness.conversation(id as never, C)) ?? Promise.reject(new Error(`No subagent ${id}.`));
		const kind = (computer: boolean) => ({
			// No instructions here: they'd join the system prompt and break the prefix cached with raubot's own turns. agents.ts puts them in the task.
			model: computer ? SOL : { provider: this.env.PROVIDER, modelId: this.env.MODEL }, thinkingLevel: "medium" as const,
			...(computer ? { extensions: { add: [this.#computer] } } : {}),
		});
		const host: AgentHost = {
			create: async (computer) => (owner
				? await owner.api.commit(async (tx) => {
					const c = await tx.createConversation({ ownership: { kind: "task", taskId: owner.api.taskId } });
					await configure(tx, c.id, kind(computer));
					return c.id;
				}, ctx)
				: (await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent: kind(computer) }, C)).id) as unknown as number,
			ask: async (id, content, requestId) => {
				const child = (owner ? await owner.api.conversation(id as never, ctx) : await this.harness.conversation(id as never, C))!;
				await (await child.submit({ type: "input", content, requestId }, ctx)).wait(ctx);
				const page = await (await conv(id)).entries({}, 3, undefined, C);
				for (const e of page.items) for (const m of e.model ?? []) if (m.role === "assistant" && m.usage) console.log("agent usage", JSON.stringify({ agent: id, input: m.usage.input, cacheRead: m.usage.cacheRead, cacheWrite: m.usage.cacheWrite, output: m.usage.output }));
				// Its box's work goes into workspace main; on a conflict it gets two tries to fix it itself.
				for (let k = 0; ; k++) {
					const why = await this.env.BOX.getByName(this.#boxOf(id)).merge();
					if (!why) { await this.env.BOX.getByName("main").pull(); return host.last(id); }
					if (k === 2) return `${await host.last(id)}\n\n[subagent ${id}'s work couldn't be merged into /workspace; it's on branch ${this.#boxOf(id)}: ${why}]`;
					await (await child.submit({ type: "input", content: `Your /workspace commits couldn't be merged into workspace main:\n${why}\nRun git rebase origin/main in /workspace, resolve the conflicts and commit, then give your result again exactly as before.`, requestId: `${requestId}:merge${k}` }, ctx)).wait(ctx);
				}
			},
			last: async (id) => {
				const page = await (await conv(id)).entries({}, 50, undefined, C);
				for (const e of page.items) for (const m of [...(e.model ?? [])].reverse()) if (m.role === "assistant") { const t = text(m.content); if (t) return t; }
				return "";
			},
			running: async (id) => {
				const s = await (await conv(id)).viewState(C);
				try { return (s.value.docs["pi.live"] as { run?: unknown } | undefined)?.run !== undefined; } finally { s.dispose(); }
			},
			steer: async (id, message) => void (await (await conv(id)).submit({ type: "input", content: message, whenBusy: "steer" }, C)),
			stop: async (id) => (await conv(id)).abort(C),
			needless: (reply) => this.#needless(reply),
		};
		return host;
	}

	async #needless(text: string) {
		const r = await this.env.AI.run("@cf/cloudflare/clef" as keyof AiModels, { model: "clef", state: text.slice(-4000), questions: CONFIRM } as never) as unknown as { answers: { asks: { noul: number }; about: { choice: string } } };
		return r.answers.asks.noul > 0.5 && r.answers.about.choice === "other";
	}

	#boxOf(conv: unknown) { return conv === this.root.id ? "main" : `agent-${conv}`; }

	/** `tools.agent`: a child conversation keyed by the script's call id, so a thawed script finds it again. */
	#agent(scope: string, caller: unknown, owner?: { api: ToolExecutionApi; ctx: Context }) {
		const host = this.#host(owner);
		return async (args: { task: string; schema?: object; computer?: boolean }, call: number) => {
			const id = caller as number;
			const info = caller === this.root.id ? undefined : (await this.ctx.storage.get<AgentInfo>(`agentinfo:${id}`)) ?? { id, task: "", started: 0 };
			const no = refuse(info, args.computer ?? false);
			if (no) throw new Error(no);
			return this.#fx(agent(host, `agent:${scope}:${call}`, args, { depth: info ? (info.depth ?? 1) + 1 : 1, ...(info && { parent: id }) }));
		};
	}

	/** A job's result: to the subagent that started it while it still runs, else to raubot (noting whose it was). */
	async #bump(from: Origin, text: string, by?: number) {
		if (by !== undefined) {
			const host = this.#host();
			try { if (await host.running(by)) return void (await host.steer(by, text)); }
			catch (e) { console.error("bump", by, e); }
			text += `\n(This job was started by subagent ${by}, which has finished: act on it for the user if needed.)`;
		}
		return this.send(text, from);
	}

	/** `tools.agents`: raubot's view of every subagent, from any turn or job. */
	#agents() {
		const host = this.#host();
		return (args: { send?: { id: number; message: string }; stop?: number[] }) => this.#fx(agents(host, args));
	}

	/** App: subagents and jobs for the sidebar. */
	async agentList() {
		const iso = (t?: number) => (t ? new Date(t).toISOString() : undefined);
		// Jobs come from DO state: cheap, and they still show if a subagent check fails.
		const jobs = await this.#fx(Effect.flatMap(Jobs, (j) => j.list())).then((all) => all.reverse().slice(0, 30)
			.map((j) => ({ id: j.id, label: j.label, status: j.status, started: iso(j.started)!, ended: iso(j.ended), deadline: iso(j.deadline)! })))
			.catch((e) => { console.error("agentList jobs", e); return []; });
		// Only recent subagents can be running; each check is bounded so one slow or dead conversation can't sink the list.
		const infos = [...(await this.ctx.storage.list<AgentInfo>({ prefix: "agentinfo:" })).values()]
			.filter((a) => a && typeof a.id === "number").sort((a, b) => b.started - a.started).filter((a, i) => i < 15 || Date.now() - a.started < 2 * 86400_000).slice(0, 40);
		const host = this.#host();
		const within = <A>(p: Promise<A>, ms: number, fallback: A) => Promise.race([p, new Promise<A>((r) => setTimeout(() => r(fallback), ms))]).catch(() => fallback);
		const agents = await Promise.all(infos.map(async (a): Promise<AgentRow> => {
			const running = await within(host.running(a.id), 3000, false);
			// Old rows can lack a task (launched with an undefined task) or a start time.
			return { id: a.id, task: String(a.task ?? "(no task)").slice(0, 200), computer: a.computer ?? false, status: running ? "running" : "idle", started: iso(a.started) ?? new Date(0).toISOString(), last: "" };
		}));
		return { agents, jobs };
	}

	async #agentRow(info: AgentInfo): Promise<AgentRow> {
		const host = this.#host();
		const [running, last] = await Promise.all([host.running(info.id), host.last(info.id)]);
		return { id: info.id, task: String(info.task ?? "(no task)"), computer: info.computer ?? false, status: running ? "running" : "idle", started: new Date(info.started || 0).toISOString(), last: String(last ?? "").slice(-600) };
	}

	/** App: a subagent's transcript, its newest 200 entries oldest first. */
	async agentTranscript(id: number) {
		const info = await this.ctx.storage.get<AgentInfo>(`agentinfo:${id}`);
		if (!info) return undefined;
		const conv = await this.harness.conversation(id as never, C);
		if (!conv) return undefined;
		const page = await conv.entries({}, 200, undefined, C);
		const cut = (s: string, n = 8000) => (s.length > n ? `${s.slice(0, n)}
… (${s.length - n} more chars)` : s);
		const lines: AgentLine[] = [];
		for (const e of [...page.items].reverse()) for (const m of (e.model ?? []) as Message[]) {
			if (m.role === "user") { const t = text(m.content); if (t) lines.push({ role: "user", text: cut(t, 20000) }); }
			else if (m.role === "assistant") {
				for (const b of m.content) {
					if (b.type === "text" && b.text) lines.push({ role: "assistant", text: b.text });
					else if (b.type === "toolCall") {
						const a = b.arguments as Record<string, unknown>;
						lines.push({ role: "tool", name: b.name, text: cut(typeof a.code === "string" ? a.code : JSON.stringify(a, null, 1)) });
					}
				}
			} else if (m.role === "toolResult") lines.push({ role: "result", name: m.toolName, text: cut(text(m.content)) });
		}
		return { agent: await this.#agentRow(info), lines };
	}

	/** App: message a subagent; a follow-up to an idle one runs on in the background and shows up in its transcript. */
	async agentSend(id: number, message: string) {
		if (!(await this.ctx.storage.get(`agentinfo:${id}`))) throw new Error(`No subagent ${id}.`);
		const host = this.#host();
		if (await host.running(id)) { await host.steer(id, message); return "steered"; }
		this.ctx.waitUntil(host.ask(id, message, `app:${id}:${Date.now()}`).catch((e) => console.error("agent send", e)));
		return "asked";
	}

	#computer!: Extension;

	#tools!: (scope: string, owner?: { api: ToolExecutionApi; ctx: Context }, by?: number) => Nested[];
	#app?: App;
	busy() { return (this.state.value.docs["pi.live"] as { run?: unknown } | undefined)?.run !== undefined; }

	/** Every message comes from a channel; non-app ones are tagged for the model and get the turn's reply. */
	async send(input: string, from: Origin = APP, files: string[] = []) {
		// The user's own messages set where heartbeat alerts go (target "last").
		if (!MACHINE.test(input)) await this.ctx.storage.put("last-from", from);
		input = tag(from, [input, ...files.map((f) => `[attached: ${f}]`)].filter(Boolean).join("\n"));
		if (from.channel !== APP.channel) {
			// A message joining a turn keeps the earliest start, so replies to earlier messages in it still go out.
			const prev = (this.busy() || (await this.#queued()).length) ? await this.ctx.storage.get<Reply>("reply") : undefined;
			const reply: Reply = prev ? { ...from, start: prev.start, ...(prev.sent !== undefined && { sent: prev.sent }) } : { ...from, start: this.memory.log.length };
			await this.ctx.storage.put({ reply, [`origin:${from.channel}`]: from });
		}
		if (this.busy()) return void (await this.root.submit({ type: "input", content: input, whenBusy: "steer" }, C));
		const queued = [...await this.#queued(), input];
		await this.ctx.storage.put("inbox", queued);
		this.#broadcast({ queued });
		void this.#drain().catch((e) => this.#broadcast({ error: String(e) }));
	}

	/** Inputs pi holds for the running turn's next step: shown in the app until they land in the log. */
	#steers(docs: Record<string, unknown>) {
		const items = (docs["pi.inbox"] as { items?: { mode: string; content?: unknown }[] } | undefined)?.items ?? [];
		return items.flatMap((x) => (x.mode === "write" ? [] : [text(x.content)]));
	}

	async #queued() { return (await this.ctx.storage.get<string[]>("inbox")) ?? []; }

	/** Starts a turn for the saved inbox, waiting briefly for summaries; unfinished view lines go in as "(summarizing...)". */
	async #drain() {
		await this.#serial(async () => {
			if (!(await this.#queued()).length) return;
			if (!this.memory.settled()) {
				this.#broadcast({ status: "settling" });
				await Promise.race([this.memory.settle(), new Promise((r) => setTimeout(r, SETTLE))]);
			}
			const input = (await this.#queued()).join("\n\n");
			if (this.busy()) await this.root.submit({ type: "input", content: input, whenBusy: "steer" }, C);
			else {
				this.memory.set("pinned", this.memory.render());
				await this.root.reset(undefined, C);
				await this.root.submit({ type: "input", content: input }, C);
			}
			await this.ctx.storage.delete("inbox");
			this.#broadcast({ queued: [] });
		});
		await this.#sync();
	}

	/** Saves a file into the box's uploads folder and gives its path, for `send`'s `files`. */
	async upload(name: string, bytes: Uint8Array) {
		const path = `${uploads()}/${uploadName(name)}`;
		await this.#fx(write(path, bytes));
		return path;
	}

	/** `tools.secrets`: asks go to the app as a form, and to other channels as a link to it. */
	async #secrets({ ask, remove = [] }: { ask?: { name: string; why: string }; remove?: string[] }) {
		const from = (await this.ctx.storage.get<Origin>("reply")) ?? APP;
		const channels = this.#channels, url = this.env.PUBLIC_URL;
		const asked = await this.#fx(Effect.gen(function* () {
			const s = yield* Secrets;
			yield* s.remove(remove);
			if (!ask) return undefined;
			const a = yield* s.ask(ask.name, ask.why, { channel: from.channel, to: from.to });
			if (from.channel !== APP.channel) yield* deliver(channels, from, `🔑 raubot needs ${a.name}: ${a.why}\n${url}/s/${a.token}`);
			return a;
		}));
		if (asked) await this.#asks();
		const list = await this.#fx(Effect.flatMap(Secrets, (s) => s.list()));
		return JSON.stringify({ ...(asked && { asked: `Asked the user for ${asked.name}${from.channel === APP.channel ? " in the app" : ` with a link over ${from.channel}`}.` }), secrets: list });
	}

	async #asks() {
		const asks = (await this.#fx(Effect.flatMap(Secrets, (s) => s.asks()))).map(({ token, name, why }) => ({ token, name, why }));
		this.#broadcast({ asks });
		return asks;
	}

	async ask(token: string) {
		const a = await this.#fx(Effect.flatMap(Secrets, (s) => s.find(token)).pipe(Effect.option));
		return a._tag === "Some" ? { token, name: a.value.name, why: a.value.why } : undefined;
	}

	async answer(token: string, value: string, ttl?: number) {
		const a = await this.#fx(Effect.flatMap(Secrets, (s) => s.answer(token, value, ttl)));
		await this.#asks();
		await this.send(`[secret ${a.name} saved] The user set ${a.name}${ttl ? `, expiring in ${Math.round(ttl / 3600)}h` : ""}. It's in your bash env now.`, a.from);
	}

	async dismiss(token: string) {
		await this.#fx(Effect.flatMap(Secrets, (s) => s.dismiss(token)));
		await this.#asks();
	}

	secrets() { return this.#fx(Effect.flatMap(Secrets, (s) => s.list())); }

	agentIndex() { return this.#fx(catalog(this.#host())); }

	removeSecret(name: string) { return this.#fx(Effect.flatMap(Secrets, (s) => s.remove([name]))); }

	#changed() {
		this.#broadcast({ log: this.memory.log.length, pending: this.memory.pending(), busy: this.state ? this.busy() : false });
		if (this.memory.pending()) void this.#arm(Date.now() + 30_000);
	}

	#broadcast(e: CoreEvent) {
		for (const f of this.#listeners) f(e);
	}

	subscribe(f: (e: CoreEvent) => void) {
		this.#listeners.add(f);
		return () => void this.#listeners.delete(f);
	}

	async snapshot() {
		const asks = (await this.#fx(Effect.flatMap(Secrets, (s) => s.asks()))).map(({ token, name, why }) => ({ token, name, why }));
		return { history: this.memory.log.slice(-200), busy: this.busy(), pending: this.memory.pending(), asks, queued: await this.#queued(), steering: this.#steers(this.state.value.docs) };
	}

	stop() { return this.root.abort(C); }

	prompt() { return this.#prompt; }

	/** Runs raubot streams itself: its root conversation's and its jobs'. */
	#mine(conv: string) { return conv.startsWith("job:") || (!!this.root && conv === String(this.root.id)); }

	/** App: traced script runs, raubot's (no conv) or one subagent's. */
	traceRuns(conv?: number) { return this.tracer.runs(conv === undefined ? (c) => this.#mine(c) : (c) => c === String(conv), 150); }
	trace(run: string) { return this.tracer.get(run); }
	traceBody(run: string, id: number) { return this.tracer.body(run, id); }

	async settings() {
		const tools = await this.ctx.storage.get<unknown[]>("executor-tools");
		return { executor: await this.oauth.connected(), tools: tools?.length ?? 0 };
	}

	async reset() {
		const keep = new Map([...await this.ctx.storage.get(["oauth-client", "oauth-tokens", "executor-tools"]), ...await this.ctx.storage.list({ prefix: "secret:" })]);
		await this.env.BOX.getByName("main").reset();
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.put(Object.fromEntries(keep));
		setTimeout(() => this.ctx.abort("history cleared"), 100);
	}

	oauthStart(origin: string) { return this.oauth.start(origin); }

	async oauthDone(params: URLSearchParams) {
		await this.oauth.callback(params);
		await this.ctx.storage.delete("executor-tools");
		// Restart so the Executor tools get registered on the next init.
		setTimeout(() => this.ctx.abort("executor connected"), 100);
	}

	/** One alarm serves memory, jobs and crons: set it to the earliest of `at` and the next cron, never later than one already set. */
	async #arm(at = Infinity) {
		const when = Math.min(at, await this.#fx(cron.wake), (await this.ctx.storage.get<number>("devin-next")) ?? Infinity, await this.#hbWake());
		const set = await this.ctx.storage.getAlarm();
		if (when < Infinity && (set === null || when < set)) await this.ctx.storage.setAlarm(Math.max(when, Date.now()));
	}

	async alarm() {
		this.memory.pump();
		for (const c of await this.#fx(cron.due(Date.now()))) await this.#fire(c).catch((e) => this.#fx(cron.record(c.id, `failed to start: ${String(e).slice(0, 200)}`)));
		await this.#devinTick().catch((e) => console.error("devin check", e));
		await this.#tick().catch((e) => console.error("heartbeat", e));
		const busy = (await this.#fx(Effect.flatMap(Jobs, (j) => j.resume()))) || this.memory.pending();
		await this.#arm(busy ? Date.now() + 30_000 : Infinity);
	}

	/** Hourly while any Devin run is open: a quiet job reads their Devin status and reports through tools.devin_runs. */
	async #devinTick(force = false) {
		const next = (await this.ctx.storage.get<number>("devin-next")) ?? 0;
		if (!force && next > Date.now()) return;
		const open = await this.#fx(devin.open);
		if (!open.length) return void (await this.ctx.storage.delete("devin-next"));
		await this.ctx.storage.put("devin-next", Date.now() + devin.HOUR);
		const code = `try {\n${devin.CHECK}\n} catch (e) { return await tools.devin_runs({ error: String(e && e.message || e) }); }`;
		await this.#fx(Effect.flatMap(Jobs, (j) => j.start(code, "devin check", 600, APP, true)));
	}

	/** Delivers Devin messages, one per channel they came from. */
	async #devinSay(items: { run: devin.Run; text?: string; images?: string[] }[]) {
		const by = new Map<string, { from: Origin; lines: string[]; files: string[] }>();
		for (const { run, text, images = [] } of items) {
			if (!text) continue;
			const k = JSON.stringify(run.from), g = by.get(k) ?? { from: run.from, lines: [], files: [] };
			g.lines.push(text);
			g.files.push(...images);
			by.set(k, g);
		}
		for (const g of by.values()) await this.send(g.lines.join("\n\n"), g.from, g.files);
	}

	/** \`tools.devin_runs\`. */
	async #devin({ add, link, prompt, close = [], all, check, report, error }: DevinArgs) {
		if (add) {
			const from = (await this.ctx.storage.get<Origin>("reply")) ?? APP;
			const r = await this.#fx(devin.add(add.purpose, { channel: from.channel, to: from.to }, add.key, add.session));
			if (!(await this.ctx.storage.get("devin-next"))) await this.ctx.storage.put("devin-next", Date.now() + devin.HOUR);
			await this.#arm(Date.now() + devin.HOUR);
			return JSON.stringify({ key: r.key, ...devin.curl(this.env.PUBLIC_URL, r) });
		}
		if (link) return JSON.stringify(devin.show(await this.#fx(devin.link(link.key, link.session))));
		if (prompt) {
			const r = await this.#fx(devin.find(prompt));
			if (!r) throw new Error("no run " + prompt);
			return JSON.stringify({ key: r.key, ...devin.curl(this.env.PUBLIC_URL, r) });
		}
		if (close.length) await this.#fx(devin.close(close));
		if (report !== undefined) {
			const items = devin.review(await this.#fx(devin.open), report);
			for (const i of items) await this.#fx(devin.update(i.run));
			await this.#devinSay(items);
			await this.ctx.storage.put("devin-check", { at: Date.now(), checked: items.length, said: items.filter((i) => i.text).length });
			return `checked ${items.length}, sent ${items.filter((i) => i.text).length}`;
		}
		if (error !== undefined) { await this.ctx.storage.put("devin-check", { at: Date.now(), error }); return "noted"; }
		if (check) await this.#devinTick(true);
		return JSON.stringify((await this.#fx(all ? devin.all : devin.open)).map(devin.show));
	}

	/** POST /s/devin/<key>: a Devin session's signed callback. Outside Access; the per-run secret is the key. */
	async devinHook(key: string, req: Request) {
		const url = new URL(req.url);
		const body = await req.text();
		if (body.length > 8000) return new Response("too big", { status: 413 });
		const r = await this.#fx(devin.callback(key, url.searchParams.get("status") ?? "done", req.headers.get("x-raubot-ts") ?? "", req.headers.get("x-raubot-sig") ?? "", body).pipe(
			Effect.map((ok) => ({ ok })), Effect.catchTag("DevinError", (e) => Effect.succeed({ err: e }))));
		if ("err" in r) return new Response(r.err.message, { status: r.err.status });
		await this.send(r.ok.text, r.ok.run.from, r.ok.images);
		return new Response("ok");
	}

	/** POST /s/devin/<key>/image?name=<file>: a signed screenshot upload. Saved in the box (shrunk to 2000px), held on the run until its next delivered message. */
	async devinImage(key: string, req: Request) {
		const url = new URL(req.url);
		const len = Number(req.headers.get("content-length") ?? 0);
		if (len > devin.MAX_IMAGE) return new Response("too big", { status: 413 });
		const bytes = new Uint8Array(await req.arrayBuffer());
		const r = await this.#fx(devin.image(key, url.searchParams.get("name") ?? "image", req.headers.get("x-raubot-ts") ?? "", req.headers.get("x-raubot-sig") ?? "", bytes).pipe(
			Effect.map((ok) => ({ ok })), Effect.catchTag("DevinError", (e) => Effect.succeed({ err: e }))));
		if ("err" in r) return new Response(r.err.message, { status: r.err.status });
		await this.#fx(write(r.ok.path, bytes));
		const f = "/workspace/" + r.ok.path;
		await this.#fx(bash("command -v mogrify >/dev/null && mogrify -resize '2000x2000>' " + JSON.stringify(f) + "; true", 60)).catch(() => undefined);
		return Response.json({ ok: true, path: r.ok.path });
	}

	/** Once: the old hourly heartbeat cron (a fresh subagent per run) gives way to the main-turn heartbeat, so the two never double-fire. */
	async #seed() {
		if (await this.ctx.storage.get("hb-migrated")) return;
		await this.#fx(cron.remove(["heartbeat"]));
		await this.ctx.storage.put({ "hb-migrated": true, "cron-seeded": true });
		await this.#hbState();
	}

	async #hbState(): Promise<hb.State> {
		const s = await this.ctx.storage.get<hb.State>("hb-state");
		if (s) return s;
		const fresh: hb.State = { ...hb.DEFAULT, tasks: {}, nextDue: hb.nextTick(Date.now(), hb.DEFAULT) };
		await this.ctx.storage.put("hb-state", fresh);
		return fresh;
	}

	/** When the alarm must wake for the heartbeat: its next tick, a deferral, or soon while a heartbeat turn runs. */
	async #hbWake() {
		const s = await this.ctx.storage.get<hb.State>("hb-state");
		if (!s) return Infinity;
		const w = (await this.ctx.storage.get<number>("hb-wake")) ?? Infinity;
		if (await this.ctx.storage.get("hb-turn")) return Math.min(w, Date.now() + hb.RETRY);
		if (w < Infinity) return w;
		if (s.paused && !s.wanted) return Infinity;
		return s.wanted ? Date.now() : s.nextDue ?? Infinity;
	}

	/** Busy for heartbeats: a turn runs, inputs wait, or a cron run is in flight. User messages always win. */
	async #hbBusy() {
		if (this.busy() || (await this.#queued()).length) return true;
		const jobs = await this.#fx(Effect.flatMap(Jobs, (j) => j.list()));
		return jobs.some((j) => j.status === "running" && j.label.startsWith("cron "));
	}

	/** The alarm's heartbeat step: close a stuck turn, else fire, defer or skip per hb.decide. */
	async #tick() {
		const beat = await this.ctx.storage.get<Beat>("hb-turn");
		if (beat) {
			if (!this.busy() && Date.now() - beat.at > hb.STUCK) await this.#endBeat(beat, { status: "failed", reason: "no reply" });
			return;
		}
		const wake = await this.ctx.storage.get<number>("hb-wake");
		if (wake !== undefined && wake > Date.now()) return;
		const s = await this.#hbState();
		const d = hb.decide(Date.now(), s, await this.#hbBusy());
		await this.ctx.storage.delete("hb-wake");
		if (d.act === "defer") await this.ctx.storage.put("hb-wake", d.at);
		else if (d.act === "quiet") await this.ctx.storage.put("hb-state", { ...s, nextDue: d.at, last: { at: Date.now(), status: "skipped", reason: "quiet-hours" } });
		else if (d.act === "fire") await this.#beat(s, d.at!);
	}

	/** One heartbeat: HEARTBEAT.md, due tasks and the user's sent-message digest go in as a "[heartbeat]" turn of raubot's own conversation. */
	async #beat(s: hb.State, nextDue: number) {
		const now = Date.now(), manual = !!s.wanted;
		const base: hb.State = { ...s, wanted: false, lastFire: now, nextDue };
		const skip = (reason: string) => this.ctx.storage.put("hb-state", { ...base, last: { at: now, status: "skipped", reason } });
		const cat = await this.#fx(Effect.flatMap(Box, (b) => b.exec("cat /workspace/HEARTBEAT.md", "", 30))).catch(() => undefined);
		const md = cat && cat.exitCode === 0 ? cat.out : undefined;
		if (md !== undefined && hb.empty(md)) return skip("empty-heartbeat-file");
		const { body, tasks } = md === undefined ? { body: undefined, tasks: [] } : hb.parse(md);
		const due = hb.dueTasks(tasks, s.tasks, now);
		if (tasks.length && !due.length && (!body || hb.empty(body)) && !manual) return skip("no-due-tasks");
		const digest = await this.#digest();
		const input = hb.input({ stamp: cron.stamp(s.activeHours.tz, now), md: body, due, digest: digest.text, manual });
		const started = await this.#serial(async () => {
			if (await this.#hbBusy()) return false;
			const beat: Beat = { at: now, tasks: due.map((t) => t.name), cursor: digest.cursor };
			await this.ctx.storage.put({ "hb-turn": beat, "hb-state": { ...base, last: { at: now, status: "running" } } });
			this.memory.set("hb-held", "[]");
			this.memory.set("pinned", this.memory.render());
			await this.root.reset(undefined, C);
			await this.root.submit({ type: "input", content: input }, C);
			return true;
		});
		if (!started) await this.ctx.storage.put({ "hb-wake": Date.now() + hb.RETRY, "hb-state": { ...s } });
		else await this.#sync();
	}

	/** Pre-turn deterministic script: /workspace/watch/sent.js (the user's own Slack, Devin and email sends since its cursor). The cursor is committed only when the turn succeeds. */
	async #digest(): Promise<{ text: string; cursor?: unknown }> {
		try {
			const r = await this.#fx(Effect.flatMap(Box, (b) => b.exec("cd /workspace && (git pull -q >/dev/null 2>&1 || true); cat watch/sent.js && printf '\\n//@@CURSOR@@\\n' && (cat watch/sent-cursor.json 2>/dev/null || echo null)", "", 60)));
			if (r.exitCode !== 0 || !r.out.includes("//@@CURSOR@@")) return { text: "(digest unavailable: /workspace/watch/sent.js missing)" };
			const [src, cur] = r.out.split("//@@CURSOR@@");
			let cursor: unknown = null;
			try { cursor = JSON.parse(cur.trim() || "null"); } catch {}
			const code = `const __r = await (async (NOW, CURSOR) => {\n${src}\n})(${JSON.stringify(new Date().toISOString())}, ${JSON.stringify(cursor)});\nreturn "@@DIGEST@@" + JSON.stringify(__r) + "@@END@@";`;
			const out = await codemode(code, this.#tools("heartbeat"), {}, AbortSignal.timeout(120_000), this.#app, undefined, Date.now() + 110_000);
			if (out.error) return { text: `(digest failed: ${out.text.slice(0, 300)})` };
			const m = /@@DIGEST@@([\s\S]*)@@END@@/.exec(out.text);
			if (!m) return { text: `(digest failed: no result: ${out.text.slice(-300)})` };
			// codemode prints a returned string JSON-quoted, so the payload comes back escaped.
			const v = (() => { try { return JSON.parse(m[1]); } catch { return JSON.parse(JSON.parse(`"${m[1]}"`)); } })() as { text?: string; cursor?: unknown };
			return { text: hb.capDigest(String(v.text ?? "")), cursor: v.cursor };
		} catch (e) { return { text: `(digest failed: ${String(e).slice(0, 300)})` }; }
	}

	/** After each sync of a heartbeat turn: once it ends, an OK is dropped (a short note logged as one line), an alert is logged and delivered, and a turn a user message joined is logged in full. */
	async #settleBeat(beat: Beat, held: Held[]) {
		if (this.busy()) return;
		const at = held.findIndex((h) => h.kind === "job" && h.text.startsWith(hb.TAG));
		const replyAt = held.findLastIndex((h) => h.kind === "talk");
		if (at < 0 || replyAt < at) return; // not started or no reply yet; #tick closes stuck turns
		if (held.some((h, i) => i !== at && (h.kind === "user" || h.kind === "devin" || (h.kind === "job" && !h.text.startsWith(hb.TAG))))) {
			for (const h of held) this.#log(h.kind, h.text, h.date);
			return this.#endBeat(beat, { status: "mixed" }, true);
		}
		const s = await this.#hbState();
		const v = hb.judge(held[replyAt].text, s.ackMaxChars);
		if (v.kind === "ok") {
			if (v.text) this.#log("job", `[heartbeat] ok: ${v.text.slice(0, 500)}`, Date.now());
			return this.#endBeat(beat, { status: "ok", ...(v.text && { note: v.text.slice(0, 500) }) }, true);
		}
		held[replyAt] = { ...held[replyAt], text: v.text };
		for (const h of held) this.#log(h.kind, h.text, h.date);
		const status = await this.#hbDeliver(s, v.text);
		return this.#endBeat(beat, { status }, true);
	}

	/** Alerts go where the user last wrote from (target "last") or to a fixed channel; a failed send falls back to the app, which shows the log. */
	async #hbDeliver(s: hb.State, text: string) {
		const to = s.target === "last" ? ((await this.ctx.storage.get<Origin>("last-from")) ?? APP) : s.target === "app" ? APP : await this.#origin(s.target).catch(() => APP);
		if (to.channel === APP.channel) return "alerted via app";
		try { await this.#fx(deliver(this.#channels, to, text)); return `alerted via ${to.channel}`; }
		catch (e) { console.error("heartbeat deliver", e); return `alerted via app (${to.channel} failed)`; }
	}

	async #endBeat(beat: Beat, out: Omit<hb.Outcome, "at">, ok = false) {
		const s = await this.#hbState();
		const tasks = { ...s.tasks };
		if (ok) for (const t of beat.tasks) tasks[t] = beat.at;
		await this.ctx.storage.put("hb-state", { ...s, tasks, last: { at: Date.now(), ...out } });
		await this.ctx.storage.delete("hb-turn");
		this.memory.set("hb-held", "[]");
		if (ok && beat.cursor) await this.#fx(write("/workspace/watch/sent-cursor.json", new TextEncoder().encode(JSON.stringify(beat.cursor)))).catch((e) => console.error("cursor", e));
		await this.#arm();
	}

	/** `tools.heartbeat`. */
	async #heartbeat({ every, activeHours, ackMaxChars, target, pause, run }: HeartbeatArgs) {
		let s = await this.#hbState();
		if (every !== undefined && !hb.duration(every)) throw new Error(`bad every "${every}" (use e.g. 30m, 2h)`);
		if (activeHours && ![activeHours.start, activeHours.end].every((t) => /^\d\d?:\d\d$/.test(t))) throw new Error("activeHours start/end: HH:MM");
		s = { ...s, ...(every && { every }), ...(activeHours && { activeHours: { ...activeHours, tz: activeHours.tz ?? s.activeHours.tz } }), ...(ackMaxChars !== undefined && { ackMaxChars }), ...(target && { target }), ...(pause !== undefined && { paused: pause }), ...(run && { wanted: true }) };
		if (every || activeHours) s.nextDue = hb.nextTick(s.lastFire ?? Date.now(), s);
		await this.ctx.storage.put("hb-state", s);
		if (run) await this.ctx.storage.delete("hb-wake");
		await this.#arm(run ? Date.now() + 5_000 : Infinity);
		const pt = (t?: number) => (t ? `${new Date(t).toLocaleString("en-US", { timeZone: cron.TZ, dateStyle: "medium", timeStyle: "short" })} PT` : undefined);
		const turn = await this.ctx.storage.get<Beat>("hb-turn");
		return JSON.stringify({ ...s, lastFire: pt(s.lastFire), nextDue: pt(s.nextDue), last: s.last && { ...s.last, at: pt(s.last.at) }, tasks: Object.fromEntries(Object.entries(s.tasks).map(([k, v]) => [k, pt(v)])), ...(turn && { running: pt(turn.at) }), ...(run && { note: "Fires as soon as raubot is idle (after this turn)." }) });
	}

	/** Where a channel reaches the user: the last place they wrote from on it. */
	async #origin(channel: string): Promise<Origin> {
		if (channel === APP.channel) return APP;
		const saved = await this.ctx.storage.get<Origin>(`origin:${channel}`);
		if (saved) return saved;
		const jobs = await this.#fx(Effect.flatMap(Jobs, (j) => j.list()));
		const seen = jobs.reverse().find((j) => j.from.channel === channel && j.from.to)?.from;
		if (!seen) throw new Error(`No ${channel} address yet: the user has to message raubot there once.`);
		return seen;
	}

	/** `tools.message`: a proactive send. Outside raubot's own turn (jobs, subagents) it's noted in the log, so raubot knows what the user got. */
	#message(own: boolean) {
		return async ({ text, channel = "imessage", files = [] }: { text: string; channel?: string; files?: string[] }) => {
			const paths = files.map((f) => (f.startsWith("/") ? f : `/workspace/${f}`));
			// A job or subagent texting the user for a needless approval (a captcha, a login) gets it from Clef instead.
			if (!own && (await this.#needless(text).catch(() => false))) {
				console.log("auto-approved", JSON.stringify({ text: text.slice(0, 200) }));
				return `Not sent: ${APPROVED} Solve captchas yourself in the browser.`;
			}
			if (channel === APP.channel) this.#log("talk", text, Date.now());
			else {
				await this.#fx(deliver(this.#channels, await this.#origin(channel), text, paths));
				if (!own) this.#log("job", `[sent via ${channel}] ${text}${paths.length ? `\n[files: ${paths.join(", ")}]` : ""}`, Date.now());
			}
			return `Sent via ${channel}.`;
		};
	}

	/** Starts one cron run. "agent": a quiet job runs the prompt on a fresh subagent and sends its reply unless silent. "turn": the prompt comes to raubot. */
	async #fire(c: cron.Cron, manual = false) {
		const unless = c.unless?.replaceAll("{date}", cron.today(c.tz));
		if (c.mode === "turn") {
			if (unless && /\[exit 0\]\s*$/.test(await this.#fx(bash(unless, 60)))) return void (await this.#fx(cron.record(c.id, "skipped")));
			return this.send(`[cron ${c.id}] ${c.prompt}`, await this.#origin(c.channel));
		}
		const when = manual ? "started by hand" : `schedule "${c.schedule}" ${c.tz}`;
		const task = `This is a run of your "${c.id}" cron (${when}), at ${cron.stamp(c.tz)}. Its prompt:\n\n${c.prompt.replaceAll("{date}", cron.today(c.tz))}\n\nYour final reply goes to the user on ${c.channel} as is. If nothing needs them, reply exactly NO_REPLY.`;
		// A pre-run script is pasted into the job, wrapped in a function so its names can't clash with the job's.
		const script = c.script ? await this.#fx(Effect.flatMap(Box, (b) => b.exec(`cat ${JSON.stringify(c.script)}`, "", 30)).pipe(
			Effect.filterOrFail((r) => r.exitCode === 0, (r) => new Error(`cron ${c.id}: script ${c.script}: ${r.err}`)), Effect.map((r) => r.out))) : "";
		const code = cron.job({ id: c.id, unless, task, channel: c.channel }, script && { source: script, now: cron.stamp(c.tz) });
		await this.#fx(Effect.flatMap(Jobs, (j) => j.start(code, `cron ${c.id}`, c.timeout, APP, true)));
	}

	/** `tools.crons`. */
	async #crons({ add, remove = [], run }: CronArgs) {
		if (remove.length) await this.#fx(cron.remove(remove));
		if (add) {
			const old = await this.#fx(cron.get(add.id));
			await this.#fx(cron.put({ tz: cron.TZ, mode: "agent", channel: "imessage", timeout: 3600, enabled: true, ...add, ...(old?.last && { last: old.last }) }));
		}
		if (run) {
			const c = await this.#fx(cron.get(run));
			if (!c) throw new Error(`No cron "${run}".`);
			await this.#fire(c, true);
		}
		await this.#arm();
		const pt = (t?: number) => (t ? `${new Date(t).toLocaleString("en-US", { timeZone: cron.TZ, dateStyle: "medium", timeStyle: "short" })} PT` : undefined);
		return JSON.stringify((await this.#fx(cron.list)).map((c) => ({ ...c, prompt: c.prompt.length > 300 ? `${c.prompt.slice(0, 300)}…` : c.prompt, next: pt(c.next), last: c.last && { ...c.last, at: pt(c.last.at) } })));
	}

	/** Channel webhooks (POST /<channel>); everything else is the web app. */
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const channel = req.method === "POST" ? this.#channels[url.pathname.slice(1)] : undefined;
		if (channel) {
			return this.#fx(channel.receive(req).pipe(
				Effect.tap((msgs) => Effect.forEach(msgs, (m) => Effect.sync(() => {
					this.ctx.waitUntil(this.#fx(acknowledge(channel, m, this.env.AI)));
					const files = m.files?.(uploads()).pipe(Effect.tapError((e) => Effect.logWarning(`${channel.name} attachments`, e)), Effect.orElseSucceed(() => [])) ?? Effect.succeed([]);
					void this.#fx(files).then((fs) => this.send(m.text, m.from, fs)).catch((e) => console.error(channel.name, e));
				}))),
				Effect.as(new Response("ok")),
				Effect.catchTag("ChannelError", (e) => Effect.succeed(new Response(e.message, { status: e.status }))),
			));
		}
		return serve(this, req);
	}
}
