import { Effect } from "effect";
import { bash, kv } from "../fx.ts";
import { type Channel, ChannelError, images } from "./index.ts";

type Content = { type: string; text?: string; url?: string; emoji?: string; content?: Content; items?: { content?: Content }[]; target?: { contentPreview?: string } };
type Webhook = { message?: { id: string; space: { id: string }; content: Content } };

const quote = (c: Content) => JSON.stringify((c.target?.contentPreview ?? "").slice(0, 200));

/** The text raubot reads from a message: a group's text parts, a reply's inner message, a link's URL, a tapback as a note. */
const textOf = (c: Content): string => {
	switch (c.type) {
		case "text": return c.text ?? "";
		case "richlink": return c.url ?? "";
		case "group": return (c.items ?? []).map((i) => (i.content ? textOf(i.content) : "")).filter(Boolean).join("\n");
		case "reply": return `(replying to ${quote(c)}) ${c.content ? textOf(c.content) : ""}`;
		case "reaction": return `[tapback ${c.emoji} on ${quote(c)}. No reply needed: reply NO_REPLY unless it changes something.]`;
		default: return "";
	}
};

/** Whether it carries files to download in the box: pictures, documents, voice memos. */
const hasFiles = (c: Content): boolean =>
	c.type === "attachment" || c.type === "voice" || (c.type === "reply" && !!c.content && hasFiles(c.content)) || (c.type === "group" && (c.items ?? []).some((i) => !!i.content && hasFiles(i.content)));

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Spectrum's webhook HMAC: hex SHA-256 of `v0:{timestamp}:{body}`, at most 5 minutes old. */
const signed = (secret: string, h: Headers, body: string) => Effect.promise(async () => {
	const ts = h.get("x-spectrum-timestamp") ?? "", sig = h.get("x-spectrum-signature") ?? "";
	if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return sig === `v0=${hex(await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${body}`)))}`;
});

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

/** Runs imessage/spectrum.mjs (from GitHub main) in the box with these env vars; `env` is for secrets, kept out of the command line. */
const spectrum = (space: string, vars: Record<string, string>, env?: Record<string, string>) => bash(`# imessage ${vars.OP}
flock /tmp/imessage.lock sh -c 'git -C raubot fetch -q && git -C raubot checkout -q origin/main -- imessage && cd raubot/imessage && { [ -d node_modules/ffmpeg-static ] || npm i -s; }' && cd raubot/imessage && ${Object.entries({ SPACE: space, ...vars }).map(([k, v]) => `${k}=${q(v)}`).join(" ")} node spectrum.mjs`, 120, env).pipe(
	Effect.mapError((e) => new ChannelError({ message: e.message, status: 502 })),
	Effect.filterOrFail((out) => /\[exit 0\]\s*$/.test(out), (out) => new ChannelError({ message: `${vars.OP} failed: ${out.slice(-500)}`, status: 502 })),
);

/** The Find My location the person in this space shares with raubot's number. */
export const location = (space: string) => spectrum(space, { OP: "location" }).pipe(Effect.map((out) => /^LOCATION (.*)$/m.exec(out)?.[1] ?? "unknown"));

/** iMessage through Photon's Spectrum. Its SDK is gRPC, which Workers can't speak, so the box runs its actions. */
export const imessage = (secret: string, openai: string): Channel => ({
	name: "imessage",
	style: "a text message: keep the reply short and in plain text, with no markdown (no **, _, #, tables or code blocks); write links as bare URLs. The one exception: a markdown image of a box file goes as a real attachment.",
	receive: (req) => Effect.gen(function* () {
		const body = yield* Effect.promise(() => req.text());
		if (!(yield* signed(secret, req.headers, body))) return yield* new ChannelError({ message: "bad signature", status: 401 });
		const { message: m } = yield* Effect.try({ try: () => JSON.parse(body) as Webhook, catch: () => new ChannelError({ message: "bad body", status: 400 }) });
		const files = !!m && hasFiles(m.content), text = m ? textOf(m.content) : "";
		console.log("imessage in", JSON.stringify({ id: m?.id, type: m?.content.type, parts: m?.content.items?.map((i) => i.content?.type), text: text.length }));
		if (!m || !(files || text) || (yield* kv.get(`imsg:${m.id}`))) return [];
		yield* kv.put({ [`imsg:${m.id}`]: 1 });
		return [{
			from: { channel: "imessage", to: m.space.id }, id: m.id, text, quiet: m.content.type === "reaction",
			files: files ? (dir: string) => spectrum(m.space.id, { OP: "download", MSG: m.id, DIR: dir }, { OPENAI_API_KEY: openai }).pipe(Effect.map((out) => JSON.parse(/^FILES (.*)$/m.exec(out)?.[1] ?? "[]") as string[])) : undefined,
		}];
	}),
	send: (to, text, extra = []) => {
		const m = images(text), files = [...new Set([...m.files, ...extra])];
		return Effect.asVoid(spectrum(to, { OP: "send", TEXT_B64: b64(m.text), ...(files.length ? { FILES: JSON.stringify(files) } : {}) }));
	},
	read: (m) => Effect.asVoid(spectrum(m.from.to, { OP: "read", MSG: m.id })),
	typing: (to, on) => Effect.asVoid(spectrum(to, { OP: "typing", ON: on ? "1" : "0" })),
	react: (m, emoji) => Effect.asVoid(spectrum(m.from.to, { OP: "react", MSG: m.id, EMOJI: emoji })),
});
