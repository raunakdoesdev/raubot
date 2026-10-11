import type { Msg } from "./memory.ts";

/** Kinds that start or join a turn: a reply right before one of them was the model's final answer to what came before. */
const INPUT = new Set<Msg["kind"]>(["user", "job", "devin"]);

/**
 * The replies a channel turn owes, oldest first, from log index `start` and after the last one sent (`sent`, a log index).
 * A talk right before a newer input is final: the model ended its answer and only then saw the next message (steered into the same turn).
 * Once the turn has `ended`, its last talk is final too. Narration before a tool call is never sent.
 */
export const finals = (log: readonly Pick<Msg, "kind" | "text">[], start: number, sent: number, ended: boolean) => {
	const at = new Set<number>();
	for (let i = Math.max(start, sent + 1); i < log.length - 1; i++) if (log[i].kind === "talk" && INPUT.has(log[i + 1].kind)) at.add(i);
	if (ended) {
		for (let i = log.length - 1; i >= start; i--) if (log[i].kind === "talk") { if (i > sent) at.add(i); break; }
	}
	return [...at].sort((a, b) => a - b).map((i) => ({ at: i, text: log[i].text }));
};
