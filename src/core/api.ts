import type { Origin } from "./channels/index.ts";
import type { Msg } from "./memory.ts";

/** What the core streams to clients: new log lines, the reply being generated, and status. */
export type CoreEvent = { history?: Msg[]; partial?: string; status?: string; log?: number; pending?: boolean; busy?: boolean; error?: string };

/** raubot's core as clients (the web app) see it. */
export interface Core {
	/** `files` are box paths from `upload`. */
	send(text: string, from?: Origin, files?: string[]): Promise<void>;
	/** Save a file into the box; gives its path. */
	upload(name: string, bytes: Uint8Array): Promise<string>;
	/** Stop the current turn. */
	stop(): Promise<void>;
	snapshot(): { history: Msg[]; busy: boolean; pending: boolean };
	subscribe(f: (e: CoreEvent) => void): () => void;
	tree(q: URLSearchParams): unknown;
	prompt(): string;
	settings(): Promise<{ executor: boolean; tools: number }>;
	/** Wipe the conversation, jobs and box snapshot (keeps app connections). */
	reset(): Promise<void>;
	/** Executor OAuth: the URL to send the user to, then the callback. */
	oauthStart(origin: string): Promise<string>;
	oauthDone(params: URLSearchParams): Promise<void>;
}
