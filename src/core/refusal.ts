import type { Memory, Msg } from "./memory.ts";

/** How a model call ended without an answer: the model declined (its input will decline again), or the call failed (it may work next time). */
export type Failure = { kind: "refusal" | "error"; why: string };

type Assistant = { stopReason: string; errorMessage?: string; content: readonly unknown[] };

/** pi-ai's wording: Anthropic stop_reason "refusal" ("The model refused..."), OpenAI-style finish_reason "content_filter", "Provider stopped with: sensitive". */
const REFUSAL = /\brefus(?:ed|al)\b|content.?filter|stopped with: sensitive/i;
const NETWORK = /connection.?refused/i;

/** An assistant message with no text and no tool call, and not stopped by the user, failed. */
export const failure = (m: Assistant): Failure | undefined => {
	if (m.stopReason === "aborted") return undefined;
	const said = m.content.some((b) => typeof b === "object" && b !== null && ((b as { type?: string }).type === "toolCall" || ((b as { type?: string }).type === "text" && String((b as { text?: unknown }).text ?? "").trim())));
	if (said) return undefined;
	const why = m.errorMessage ?? `stop reason ${m.stopReason}`;
	return { kind: REFUSAL.test(why) && !NETWORK.test(why) ? "refusal" : "error", why };
};

/** Owner commands, said alone as a whole message: never logged, never seen by the model. */
export type Command = "undo" | "restore";
export const command = (text: string): Command | undefined => {
	const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
	if (t === "undo" || t === "delete last" || t === "/undo") return "undo";
	if (t === "restore" || t === "/restore") return "restore";
	return undefined;
};

/** Where a turn's inputs are in the log: from its first message to the end. Undo takes the user's last message and everything after it. */
export const lastExchange = (log: readonly Pick<Msg, "i" | "kind">[], hidden: ReadonlySet<number>) => {
	for (let k = log.length - 1; k >= 0; k--) if (log[k].kind === "user" && !hidden.has(log[k].i)) return log.slice(k).map((m) => m.i).filter((i) => !hidden.has(i));
	return [];
};

const quote = (s: string) => {
	const t = s.replace(/^\[via \w+\] /, "").replace(/\s+/g, " ").trim();
	return t.length > 60 ? `${t.slice(0, 57)}...` : t;
};

/** A run from log index `from` ended without an answer. A refusal hides the run's messages, since each later turn would carry them and be refused again. Gives what to tell the user and what to log. */
export const settle = (memory: Memory, f: Failure, from: number, heartbeat: boolean) => {
	const run = heartbeat ? [] : memory.log.slice(from);
	const first = run.find((m) => m.kind === "user")?.text;
	const hid = f.kind === "refusal" && memory.hide(run.map((m) => m.i), "the model declined this turn") !== undefined;
	return { ...notice(f, first, hid), hid };
};

/** What the user is told, on the channel the turn came from. The log keeps a version without the quote, so the hidden text never re-enters the VIEW. */
export const notice = (f: Failure, first: string | undefined, hid: boolean) => {
	const q = first ? ` on your message "${quote(first)}"` : "";
	if (f.kind === "refusal") return {
		say: `The model declined to answer${q}. ${hid ? "I've set that message aside so it doesn't block later replies. Say \"restore\" to bring it back, or just rephrase." : "Try rephrasing it."}`,
		log: `[the model declined to answer; ${hid ? "that turn is hidden, \"restore\" brings it back" : "nothing hidden"}] (${f.why})`,
	};
	return {
		say: `My reply${q} failed on the model provider's side, even after retries (${f.why.slice(0, 120)}). Send it again in a minute, or say "undo" to drop it.`,
		log: `[model call failed after retries: ${f.why.slice(0, 200)}]`,
	};
};
