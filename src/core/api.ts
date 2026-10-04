import type { Origin } from "./channels/index.ts";
import type { Msg } from "./memory.ts";
import type { Secret } from "./secrets.ts";

/** A secret raubot is waiting on; the token is the key to its form. */
export type SecretAsk = { token: string; name: string; why: string };

/** What the core streams to clients: new log lines, the reply being generated, and status. */
export type CoreEvent = { asks?: SecretAsk[]; history?: Msg[]; partial?: string; status?: string; log?: number; pending?: boolean; busy?: boolean; error?: string };

/** raubot's core as clients (the web app) see it. */
export interface Core {
	/** `files` are box paths from `upload`. */
	send(text: string, from?: Origin, files?: string[]): Promise<void>;
	/** Save a file into the box; gives its path. */
	upload(name: string, bytes: Uint8Array): Promise<string>;
	/** Stop the current turn. */
	stop(): Promise<void>;
	snapshot(): Promise<{ history: Msg[]; busy: boolean; pending: boolean; asks: SecretAsk[] }>;
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
	/** Executor OAuth: the URL to send the user to, then the callback. */
	oauthStart(origin: string): Promise<string>;
	oauthDone(params: URLSearchParams): Promise<void>;
}
