// One iMessage action via Spectrum (gRPC, so it runs in the box, not the Worker).
// OP=send TEXT_B64 (markdown, rendered as iMessage styled text) [FILES: JSON list of box paths, sent as attachments] | OP=read MSG | OP=typing ON=1|0 | OP=react MSG EMOJI | OP=location (prints LOCATION {Find My location of the space's person}) | OP=download MSG DIR (prints FILES [paths]; a voice memo is transcribed with OPENAI_API_KEY)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { existsSync } from "node:fs";
import { attachment, markdown, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
const { SPECTRUM_PROJECT_ID: projectId, SPECTRUM_PROJECT_SECRET: projectSecret, OP, SPACE, MSG, TEXT_B64, FILES, ON, EMOJI, DIR } = process.env;
// iMessage voice memos are often CAF, which OpenAI doesn't take, so they go through mp3 first.
async function transcribe(path) {
  const mp3 = `/tmp/${Date.now().toString(36)}.mp3`;
  await promisify(execFile)(ffmpeg, ["-y", "-loglevel", "error", "-i", path, mp3]);
  const form = new FormData();
  form.append("model", "gpt-transcribe");
  form.append("file", new Blob([await readFile(mp3)], { type: "audio/mpeg" }), "voice.mp3");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
  if (!r.ok) throw new Error(`transcription ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return JSON.stringify((await r.json()).text);
}
const provider = imessage.config();
// spectrum-ts has no locations API, so this action hands out the provider's own Advanced iMessage client's.
provider.__definition.actions.locations = async ({ client }) => client[0].client.locations;
const app = await Spectrum({ projectId, projectSecret, providers: [provider] });
const space = await imessage(app).space.get(SPACE);
const message = async () => (await space.getMessage(MSG)) ?? Promise.reject(new Error(`no message ${MSG}`));
if (OP === "send") {
  const want = FILES ? JSON.parse(FILES) : [];
  const files = want.filter((f) => /^\/(workspace|scratch)\//.test(f) && existsSync(f));
  const lost = want.length - files.length;
  const text = Buffer.from(TEXT_B64, "base64").toString("utf8") + (lost ? `\n(${lost} image${lost > 1 ? "s" : ""} missing)` : "");
  const parts = [...(text.trim() ? [markdown(text)] : []), ...files.map((f) => attachment(f))];
  if (parts.length) await space.send(...parts);
}
else if (OP === "read") await (await message()).read();
else if (OP === "typing") await (ON === "1" ? space.startTyping() : space.stopTyping());
else if (OP === "location") console.log(`LOCATION ${JSON.stringify(await (await imessage(app).locations()).get(SPACE.split(";").pop()))}`);
else if (OP === "react") await (await message()).react(EMOJI);
else if (OP === "download") {
  const parts = (c) => c.type === "group" ? c.items.flatMap((i) => parts(i.content)) : c.type === "reply" ? parts(c.content) : [c];
  await mkdir(`/workspace/${DIR}`, { recursive: true });
  const files = [];
  for (const a of parts((await message()).content).filter((p) => p.type === "attachment" || p.type === "voice")) {
    const f = `${DIR}/${Date.now().toString(36)}-${(a.name ?? "voice.m4a").replace(/[^\w.-]+/g, "_").slice(-80)}`;
    await writeFile(`/workspace/${f}`, await a.read());
    files.push(a.type === "voice" ? `${f} (voice memo; transcript: ${await transcribe(`/workspace/${f}`).catch((e) => `failed, ${e.message}`)})` : f);
  }
  console.log(`FILES ${JSON.stringify(files)}`);
}
else throw new Error(`unknown OP ${OP}`);
process.exit(0);
