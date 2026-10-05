import { Data, Effect } from "effect";
import type { Box, Storage } from "../fx.ts";
import { imessage } from "./imessage.ts";

/** Where a message came from, and so where its turn's reply goes. */
export type Origin = { channel: string; to: string };
export const APP: Origin = { channel: "app", to: "" };
/** `id` is the channel's own message id, for receipts and reactions. `files` saves the message's attachments into `dir` in the box and gives their paths. */
export type Inbound = { from: Origin; id: string; text: string; files?: (dir: string) => Effect.Effect<string[], ChannelError, Box> };

/** Where uploads land in the box, relative to /workspace: one folder per day. */
export const uploads = () => `uploads/${new Date().toISOString().slice(0, 10)}`;
export const uploadName = (name: string) => `${Date.now().toString(36)}-${name.replace(/[^\w.-]+/g, "_").slice(-80)}`;

export class ChannelError extends Data.TaggedError("ChannelError")<{ message: string; status: number }> {}

/** A way to reach the user besides the app (which needs no adapter: it shows the whole chat). */
export interface Channel {
	readonly name: string;
	/** How replies on this channel should look; goes in the system prompt. */
	readonly style: string;
	/** A webhook request (POST /<name>) as verified, deduped messages. */
	receive(req: Request): Effect.Effect<Inbound[], ChannelError, Storage>;
	/** Sending a message also ends a typing indicator. Markdown images of box files (see `images`) go as attachments. */
	send(to: string, text: string): Effect.Effect<void, ChannelError, Box>;
	/** Optional presence, where the channel has it: read receipts, typing indicator, emoji reactions. */
	read?(m: Inbound): Effect.Effect<void, ChannelError, Box>;
	typing?(to: string, on: boolean): Effect.Effect<void, ChannelError, Box>;
	react?(m: Inbound, emoji: string): Effect.Effect<void, ChannelError, Box>;
}

export type ChannelEnv = { SPECTRUM_WEBHOOK_SECRET: string };
export type Channels = Readonly<Record<string, Channel>>;

export const channels = (env: ChannelEnv): Channels =>
	Object.fromEntries([imessage(env.SPECTRUM_WEBHOOK_SECRET)].map((c) => [c.name, c]));

/** What the model sees: the app's messages as typed, others tagged with their channel. */
export const tag = (from: Origin, text: string) => (from.channel === APP.channel ? text : `[via ${from.channel}] ${text}`);

/** Markdown images of box files: ![alt](/workspace/...) or ![alt](/scratch/...). Channels send these as attachments. */
const IMAGE = /!\[[^\]]*\]\(<?(\/(?:workspace|scratch)\/[^\s)>]+\.(?:png|jpe?g|gif|webp|heic))>?(?:\s+"[^"]*")?\)/gi;
export const images = (text: string) => {
	const files = [...new Set([...text.matchAll(IMAGE)].map((m) => m[1]))];
	return { text: text.replace(IMAGE, "").replace(/\n{3,}/g, "\n\n").trim(), files };
};

export const send = (cs: Channels, to: Origin, text: string) =>
	cs[to.channel]?.send(to.to, text) ?? Effect.fail(new ChannelError({ message: `No channel "${to.channel}".`, status: 404 }));

export const channelDoc = (cs: Channels) =>
	[`Messages starting with "[via <channel>]" came from that channel instead of this app, and your final reply is sent back there.`,
		...Object.values(cs).map((c) => `"[via ${c.name}]": ${c.style}`)].join("\n");

const REACTIONS = {
	none: "No reaction: a plain request, question or instruction.",
	"❤️": "Warm or kind.", "👍": "An acknowledgement or a plan to agree with.", "😂": "Funny.",
	"‼️": "Big news.", "🎉": "Something to celebrate.", "🙏": "A thank-you.",
};

/** Clef picks the emoji a friend would tap back, if any. */
const pickReaction = (ai: Ai, text: string) => Effect.tryPromise(() => ai.run("@cf/cloudflare/clef-flash" as keyof AiModels, {
	model: "clef-flash", state: text,
	questions: { r: { type: "choice", criteria: REACTIONS, instructions: "Someone texted this to their assistant. Would a friend tap back an emoji reaction on it, and which one? Most requests and questions get none." } },
} as never) as unknown as Promise<{ answers: { r: { choice: string; probabilities: Record<string, number> } } }>).pipe(
	Effect.map(({ answers: { r } }) => (r.choice !== "none" && (r.probabilities.none ?? 1) < 0.25 ? r.choice : undefined)),
);

/** Right as a message lands: mark it read, show typing, and tap back an emoji if one fits. Best effort. */
export const acknowledge = (c: Channel, m: Inbound, ai: Ai) => Effect.all([
	c.read?.(m) ?? Effect.void,
	c.typing?.(m.from.to, true) ?? Effect.void,
	c.react && m.text ? pickReaction(ai, m.text).pipe(Effect.flatMap((e) => (e ? c.react!(m, e) : Effect.void))) : Effect.void,
], { concurrency: "unbounded", mode: "either" }).pipe(Effect.tap((rs) => Effect.forEach(rs, (r) => (r._tag === "Left" ? Effect.logWarning(`${c.name} presence`, r.left) : Effect.void))), Effect.asVoid);

/** A turn that ended without a reply still clears the typing indicator. */
export const idle = (cs: Channels, to: Origin) => cs[to.channel]?.typing?.(to.to, false).pipe(Effect.ignoreLogged) ?? Effect.void;
