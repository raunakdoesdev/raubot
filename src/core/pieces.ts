import { BLOCK } from "./prompts.ts";

/**
 * The pinned view as content blocks of BLOCK lines each (OptChat): Anthropic looks back up to 20 blocks from a mark for an earlier entry,
 * so the next call finds this call's mark and pays only for the lines after it. `mark` is the index of the last whole block (-1: none).
 */
export const pieces = (view: string, head = "<view>\n", tail = "\n</view>\n\nNew message:\n") => {
	const lines = view ? view.split("\n") : [];
	const whole = lines.length - (lines.length % BLOCK);
	const out: string[] = [];
	for (let k = 0; k < whole; k += BLOCK) out.push((k === 0 ? head : "") + lines.slice(k, k + BLOCK).map((l) => `${l}\n`).join(""));
	const rest = lines.slice(whole).join("\n");
	out.push((whole === 0 ? head : "") + rest + (rest || whole === 0 ? tail : tail.replace(/^\n/, "")));
	return { out, mark: whole ? whole / BLOCK - 1 : -1 };
};
