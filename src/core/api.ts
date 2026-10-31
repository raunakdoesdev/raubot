import type { Origin } from "./channels/index.ts";
import type { Msg } from "./memory.ts";
import type { Secret } from "./secrets.ts";
import type { TraceCall, TraceRun } from "./trace.ts";
import type { View as Tasks } from "./todos.ts";

/** A secret raubot is waiting on; the token is the key to its form. */
export type SecretAsk = { token: string; name: string; why: string };

/** What the core streams to clients: new log lines, the reply being generated, and status. */
export type CoreEvent = { tasks?: Tasks; asks?: SecretAsk[]; history?: Msg[]; reload?: Msg[]; partial?: string; queued?: string[]; steering?: string[]; status?: string; log?: number; pending?: boolean; busy?: boolean; error?: string };

/** A subagent as the app lists it (like `tools.agents`). */
export type AgentRow = { id: number; task: string; computer: boolean; writer?: boolean; status: "running" | "idle"; started: string; last: string };
/** A background job, read-only. */
export type JobRow = { id: number; label: string; status: string; started: string; ended?: string; deadline: string };
/** One transcript line of a subagent. */
export type AgentLine = { role: "user" | "assistant" | "tool" | "result"; text: string; name?: string };

/** raubot's core as clients (the web app) see it. */
export interface Core {
	/** `files` are box paths from `upload`. */
	send(text: string, from?: Origin, files?: string[]): Promise<void>;
	/** Save a file into the box; gives its path. */
	upload(name: string, bytes: Uint8Array): Promise<string>;
	redact(i: number, text: string): Promise<boolean>;
	/** Hides messages from raubot's memory as one restorable group (soft delete). */
	hide(ids: number[]): Promise<boolean>;
	/** Brings back the latest hidden group; gives its message ids. */
	restore(): Promise<number[]>;
	/** Stop the current turn. */
	stop(): Promise<void>;
	snapshot(): Promise<{ history: Msg[]; busy: boolean; pending: boolean; asks: SecretAsk[]; queued: string[]; tasks: Tasks }>;
	subscribe(f: (e: CoreEvent) => void): () => void;
	tree(q: URLSearchParams): unknown;
	prompt(): string;
	settings(): Promise<{ executor: boolean; tools: number }>;
	/** The secret ask behind a form link, if it's still open. */
	ask(token: string): Promise<SecretAsk | undefined>;
	/** Answer an ask; `ttl` in seconds, none keeps it until removed. */
	answer(token: string, value: string, ttl?: number): Promise<void>;
	/** Drop an ask without answering it; raubot isn't told. */
	dismiss(token: string): Promise<void>;
	secrets(): Promise<Secret[]>;
	removeSecret(name: string): Promise<void>;
	/** Wipe the conversation, jobs and box snapshot (keeps app connections). */
	reset(): Promise<void>;
	/** Subagents (newest first) and background jobs. */
	agentList(): Promise<{ agents: AgentRow[]; jobs: JobRow[] }>;
	/** The box a subagent runs in ("agent-<id>", or its caller's for vm "shared"); undefined: no such subagent. */
	agentBox(id: number): Promise<string | undefined>;
	/** A subagent's transcript, oldest first. */
	agentTranscript(id: number): Promise<{ agent: AgentRow; lines: AgentLine[] } | undefined>;
	/** Message a subagent like `tools.agents` send: steers a running one, or starts a follow-up of an idle one (don't wait for its reply). */
	agentSend(id: number, message: string): Promise<string>;
	/** Executor OAuth: the URL to send the user to, then the callback. */
	oauthStart(origin: string): Promise<string>;
	oauthDone(params: URLSearchParams): Promise<void>;
	/** Traced codemode runs, oldest first: raubot's and its jobs', or one subagent's. Live ones also stream as `{ trace: TraceEvent }` events. */
	traceRuns(conv?: number): Promise<TraceRun[]>;
	/** One run with its nested call summaries. */
	trace(run: string): Promise<{ run: TraceRun; calls: TraceCall[] } | undefined>;
	/** One nested call's full args and result (truncated). */
	traceBody(run: string, id: number): Promise<{ args: string; out?: string } | undefined>;
	/** Every subagent (newest first) for search, without last output. */
	agentIndex(): Promise<Omit<AgentRow, "last">[]>;
	/** Voice agent tools: ask raubot (internal, never sent to a channel), wait for a pending reply, peek at status. */
	voiceAsk(message: string, ms?: number): Promise<{ id: string } & ({ status: "done"; reply: string } | { status: "working"; steps: string[] } | { status: "unknown" })>;
	voiceWait(id: string, ms?: number): Promise<{ status: "done"; reply: string } | { status: "working"; steps: string[] } | { status: "unknown" }>;
	voiceStatus(): Promise<{ busy: boolean; queued: number; steps: string[] }>;
	/** Mint an ephemeral realtime key for the browser. */
	voiceSession(): Promise<{ key: string; expires_at?: number; model: string }>;
	/** POST /s/devin/<key>: a Devin run's signed callback. */
	devinHook(key: string, req: Request): Promise<Response>;
	/** POST /s/devin/<key>/image: a Devin run's signed screenshot upload. */
	devinImage(key: string, req: Request): Promise<Response>;
	/** The iOS app's task routes (bearer-checked at the edge). */
	tasksApi(req: Request): Promise<Response>;
	/** One-tap pairing: POST /api/pair/new (Access + app token) and POST /api/pair/redeem (public). */
	pairApi(req: Request): Promise<Response>;
	/** Start on the Tasks tab: sets the task working; throws if there's no such task. */
	startTask(id: string): Promise<Tasks["tasks"][number]>;
}
