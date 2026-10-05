// The browser tool's box side: browser/cli.mjs drives one persistent Chromium (browser/server.mjs) in the box.
import { Effect } from "effect";
import { Box } from "./fx.ts";

/** Fetch browser/ from raubot main, install its packages and Chromium once (kept by snapshots), then run. Install noise goes to stderr. */
const ENSURE = `flock /tmp/browser.lock sh -c 'git -C raubot fetch -q && git -C raubot checkout -q origin/main -- browser && cd raubot/browser && { [ -d node_modules ] || npm i -s --no-audit --no-fund; } && ln -sf "$PWD/vault" /usr/local/bin/vault && { [ -f ~/.raubot/chromium ] || { npx playwright install --with-deps chromium && mkdir -p ~/.raubot && touch ~/.raubot/chromium; }; }' >&2`;

export type Jar = Record<string, unknown[]>;
export type Shot = { out: string; error?: boolean; images: string[]; tabs: string; changed?: Jar };

export const browse = (code: string, timeout: number, env: Record<string, string>, jar: Jar = {}) => Effect.gen(function* () {
	const box = yield* Box;
	const r = yield* box.exec(`${ENSURE} && node raubot/browser/cli.mjs run`, JSON.stringify({ code, timeout, jar }), timeout + 600, env);
	if (r.exitCode) return { out: `browser failed (exit ${r.exitCode}):\n${r.err.slice(-3000)}`, error: true, images: [], tabs: "" } satisfies Shot;
	return JSON.parse(r.out) as Shot;
});

type ResponsesPayload = { tools?: unknown[]; input?: { type?: string; output?: unknown }[] };
type Part = { type: string; detail?: string; image_url?: string; text?: string };

/** Screenshots to keep in a request; older ones become a note so long browser runs stay small. */
const KEEP = 4;

/** OpenAI Responses requests: newest screenshots at full detail (OpenAI's advice for computer use), plus OpenAI's own web search. */
export const responses = (payload: unknown) => {
	const p = payload as ResponsesPayload;
	let seen = 0;
	for (const item of [...(p.input ?? [])].reverse()) {
		if (item.type !== "function_call_output" || !Array.isArray(item.output)) continue;
		for (const part of [...(item.output as Part[])].reverse()) {
			if (part.type !== "input_image") continue;
			if (seen++ < KEEP) part.detail = "original";
			else { part.type = "input_text"; part.text = "[older screenshot dropped]"; delete part.image_url; delete part.detail; }
		}
	}
	return { ...p, tools: [...(p.tools ?? []), { type: "web_search" }] };
};
