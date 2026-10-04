import type { Origin } from "./channels/index.ts";
import type { Msg } from "./memory.ts";

/** What the core streams to clients: new log lines, the reply being generated, and status. */
export type CoreEvent = { history?: Msg[]; partial?: string; status?: string; log?: number; pending?: boolean; busy?: boolean; error?: string };

/** raubot's core as clients (the web app) see it. */
export interface Core {
	send(text: string, from?: Origin): Promise<void>;
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
