import { Effect } from "effect";
import { bash, kv } from "../fx.ts";
import { type Channel, ChannelError, images } from "./index.ts";

type Webhook = { message?: { id: string; space: { id: string }; content: { type: string; text?: string } } };

/** Spectrum content types raubot takes in: text, or one or more files. */
const FILES = new Set(["attachment", "group"]);

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

/** Runs imessage/spectrum.mjs (from GitHub main) in the box with these env vars. */
const spectrum = (space: string, vars: Record<string, string>) => bash(`# imessage ${vars.OP}
flock /tmp/imessage.lock sh -c 'git -C raubot fetch -q && git -C raubot checkout -q origin/main -- imessage && cd raubot/imessage && { [ -d node_modules ] || npm i -s; }' && cd raubot/imessage && ${Object.entries({ SPACE: space, ...vars }).map(([k, v]) => `${k}=${q(v)}`).join(" ")} node spectrum.mjs`, 120).pipe(
	Effect.mapError((e) => new ChannelError({ message: e.message, status: 502 })),
	Effect.filterOrFail((out) => /\[exit 0\]\s*$/.test(out), (out) => new ChannelError({ message: `${vars.OP} failed: ${out.slice(-500)}`, status: 502 })),
);

/** iMessage through Photon's Spectrum. Its SDK is gRPC, which Workers can't speak, so the box runs its actions. */
export const imessage = (secret: string): Channel => ({
	name: "imessage",
	style: "a text message: keep the reply short. Markdown is converted to iMessage styling (markdown images of box files go as real attachments), so use only **bold**, _italic_, ~~strikethrough~~, `code` (shown in a monospace font), - bullets, 1. numbered lists and > quotes. Headings come out as bold lines, links as text (url) and tables as rows split by |. Never send long code blocks.",
	receive: (req) => Effect.gen(function* () {
		const body = yield* Effect.promise(() => req.text());
		if (!(yield* signed(secret, req.headers, body))) return yield* new ChannelError({ message: "bad signature", status: 401 });
		const { message: m } = yield* Effect.try({ try: () => JSON.parse(body) as Webhook, catch: () => new ChannelError({ message: "bad body", status: 400 }) });
		const files = FILES.has(m?.content.type ?? "");
		if (!m || !(files || (m.content.type === "text" && m.content.text)) || (yield* kv.get(`imsg:${m.id}`))) return [];
		yield* kv.put({ [`imsg:${m.id}`]: 1 });
		return [{
			from: { channel: "imessage", to: m.space.id }, id: m.id, text: m.content.text ?? "",
			files: files ? (dir: string) => spectrum(m.space.id, { OP: "download", MSG: m.id, DIR: dir }).pipe(Effect.map((out) => JSON.parse(/^FILES (.*)$/m.exec(out)?.[1] ?? "[]") as string[])) : undefined,
		}];
	}),
	send: (to, text) => {
		const m = images(text);
		return Effect.asVoid(spectrum(to, { OP: "send", TEXT_B64: b64(m.text), ...(m.files.length ? { FILES: JSON.stringify(m.files) } : {}) }));
	},
	read: (m) => Effect.asVoid(spectrum(m.from.to, { OP: "read", MSG: m.id })),
	typing: (to, on) => Effect.asVoid(spectrum(to, { OP: "typing", ON: on ? "1" : "0" })),
	react: (m, emoji) => Effect.asVoid(spectrum(m.from.to, { OP: "react", MSG: m.id, EMOJI: emoji })),
});
