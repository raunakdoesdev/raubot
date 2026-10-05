import type { Origin } from "./channels/index.ts";
import type { Msg } from "./memory.ts";
import type { Secret } from "./secrets.ts";
import type { TraceCall, TraceRun } from "./trace.ts";

/** A secret raubot is waiting on; the token is the key to its form. */
export type SecretAsk = { token: string; name: string; why: string };

/** What the core streams to clients: new log lines, the reply being generated, and status. */
export type CoreEvent = { asks?: SecretAsk[]; history?: Msg[]; partial?: string; queued?: string[]; steering?: string[]; status?: string; log?: number; pending?: boolean; busy?: boolean; error?: string };

/** A subagent as the app lists it (like `tools.agents`). */
export type AgentRow = { id: number; task: string; computer: boolean; status: "running" | "idle"; started: string; last: string };
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
	/** Stop the current turn. */
	stop(): Promise<void>;
	snapshot(): Promise<{ history: Msg[]; busy: boolean; pending: boolean; asks: SecretAsk[]; queued: string[] }>;
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
	/** POST /s/devin/<key>: a Devin run's signed callback. */
	devinHook(key: string, req: Request): Promise<Response>;
}
