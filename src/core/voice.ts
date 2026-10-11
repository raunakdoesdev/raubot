// Voice: a separate realtime speech-to-speech session (OpenAI Realtime over WebRTC in the browser) that talks to raubot through tools.
// The voice agent never gets raubot's context; it asks raubot by text. Those messages are internal: they show in the app as "[via voice]"
// and their replies NEVER go out over iMessage or any other channel.
import type { Msg } from "./memory.ts";
import { finals } from "./replies.ts";

export const TAG = "[via voice]";
export const DEFAULT_MODEL = "gpt-realtime";
export const DEFAULT_VOICE = "marin";

type L = Pick<Msg, "kind" | "text">;

/** The input a talk at i answers: the nearest user line before it. */
export const inputBefore = (log: readonly L[], i: number) => {
	for (let j = i - 1; j >= 0; j--) if (log[j].kind === "user") return j;
	return -1;
};

/** A reply belongs to voice when the input it answers came from voice (a merged input with any voice part counts: never leak it to a channel). */
export const ownedByVoice = (log: readonly L[], i: number) => {
	const j = inputBefore(log, i);
	return j >= 0 && log[j].text.includes(TAG);
};

/** Where an ask's input landed in the log (from start), or -1 while it's still queued. */
export const landed = (log: readonly L[], start: number, input: string) => {
	for (let j = Math.max(0, start); j < log.length; j++) if (log[j].kind === "user" && log[j].text.includes(input)) return j;
	return -1;
};

/** The answer to a voice ask once there is one: the voice-owned final replies after its input. undefined while waiting; "" when the turn ended silent. */
export const answer = (log: readonly L[], start: number, input: string, ended: boolean): string | undefined => {
	const at = landed(log, start, input);
	if (at < 0) return undefined;
	const rs = finals(log, at, at, ended).filter((r) => ownedByVoice(log, r.at));
	if (rs.length) return rs.map((r) => r.text).join("\n\n");
	return ended ? "" : undefined;
};

/** What raubot did since start: short lines for the voice agent's peek tool. */
export const progress = (log: readonly L[], start: number, max = 6) =>
	log.slice(Math.max(0, start)).filter((m) => m.kind !== "user").slice(-max).map((m) => {
		const t = m.text.replace(/\s+/g, " ");
		return m.kind === "tool" ? "tool: " + t.slice(0, 120) : m.kind === "echo" ? "result: " + t.slice(0, 160) : m.kind + ": " + t.slice(0, 300);
	});

/** The style rule raubot follows for voice messages (goes in its system prompt). */
export const STYLE = '"' + TAG + '": an internal message from your realtime voice agent, which is talking with the user out loud right now and relays what he says. Do the work as usual, then reply in a few short spoken sentences: plain words, no markdown, links, lists, ids or code; it is read aloud. Your reply goes ONLY back to the voice agent (and shows in the app): never send voice messages or their replies over iMessage or tools.message unless the user explicitly asks for a text.';

export const INSTRUCTIONS = [
	"You are raubot's voice: a fast, warm, concise voice assistant talking with Raunak (the user) in real time.",
	"You do not know his context, calendar, email, files or projects. raubot, a capable agent with all of that, does the real work.",
	"- For anything beyond small talk, call ask_raubot with a clear, self-contained message of what Raunak wants (his words plus what you know from this call). Before calling, say a few words like 'on it'.",
	"- If ask_raubot returns status 'working', tell Raunak briefly, then call raubot_wait with the id. Keep calling raubot_wait while it says working, with a short update now and then. Use raubot_status if he asks what raubot is doing.",
	"- Read raubot's answer back naturally and briefly. Don't invent facts raubot didn't give.",
	"- Keep turns short. If Raunak interrupts, stop and listen. Speak English unless he switches.",
].join("\n");

/** Function tools of the voice session (OpenAI Realtime format). */
export const TOOLS = [
	{ type: "function", name: "ask_raubot", description: "Send raubot (the agent that does the real work and knows Raunak's context) a message and get its reply. Returns {status:'done', reply} or, if it takes long, {status:'working', id}: then call raubot_wait.",
		parameters: { type: "object", properties: { message: { type: "string", description: "Self-contained request for raubot." } }, required: ["message"] } },
	{ type: "function", name: "raubot_wait", description: "Wait up to ~20s more for the reply to an ask_raubot that returned status 'working'.",
		parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
	{ type: "function", name: "raubot_status", description: "Peek at what raubot is doing right now: busy or idle, and its latest steps.",
		parameters: { type: "object", properties: {} } },
];

/** Body for POST https://api.openai.com/v1/realtime/client_secrets: an ephemeral key (10 min) with the session preset server-side. */
export const sessionConfig = (model = DEFAULT_MODEL, voice = DEFAULT_VOICE) => ({
	expires_after: { anchor: "created_at", seconds: 600 },
	session: {
		type: "realtime", model, instructions: INSTRUCTIONS, tools: TOOLS, tool_choice: "auto",
		audio: {
			input: { turn_detection: { type: "semantic_vad", eagerness: "auto", interrupt_response: true, create_response: true }, transcription: { model: "gpt-4o-mini-transcribe" }, noise_reduction: { type: "near_field" } },
			output: { voice },
		},
	},
});
