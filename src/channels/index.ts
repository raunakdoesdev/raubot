import { Data, Effect } from "effect";
import type { Box, Storage } from "../fx.ts";
import { imessage } from "./imessage.ts";

/** Where a message came from, and so where its turn's reply goes. */
export type Origin = { channel: string; to: string };
export const APP: Origin = { channel: "app", to: "" };
export type Inbound = { from: Origin; text: string };

export class ChannelError extends Data.TaggedError("ChannelError")<{ message: string; status: number }> {}

/** A way to reach the user besides the app (which needs no adapter: it shows the whole chat). */
export interface Channel {
	readonly name: string;
	/** How replies on this channel should look; goes in the system prompt. */
	readonly style: string;
	/** A webhook request (POST /<name>) as verified, deduped messages. */
	receive(req: Request): Effect.Effect<Inbound[], ChannelError, Storage>;
	send(to: string, text: string): Effect.Effect<void, ChannelError, Box>;
}

export type ChannelEnv = { SPECTRUM_WEBHOOK_SECRET: string };
export type Channels = Readonly<Record<string, Channel>>;

export const channels = (env: ChannelEnv): Channels =>
	Object.fromEntries([imessage(env.SPECTRUM_WEBHOOK_SECRET)].map((c) => [c.name, c]));

/** What the model sees: the app's messages as typed, others tagged with their channel. */
export const tag = (from: Origin, text: string) => (from.channel === APP.channel ? text : `[via ${from.channel}] ${text}`);

export const send = (cs: Channels, to: Origin, text: string) =>
	cs[to.channel]?.send(to.to, text) ?? Effect.fail(new ChannelError({ message: `No channel "${to.channel}".`, status: 404 }));

export const channelDoc = (cs: Channels) =>
	[`Messages starting with "[via <channel>]" came from that channel instead of this app, and your final reply is sent back there.`,
		...Object.values(cs).map((c) => `"[via ${c.name}]": ${c.style}`)].join("\n");
