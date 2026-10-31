// One iMessage action via Spectrum (gRPC, so it runs in the box, not the Worker).
// OP=send TEXT_B64 (markdown, rendered as iMessage styled text) [FILES: JSON list of box paths, sent as attachments; with R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY, files over 5 MB go as 7-day R2 links instead] | OP=read MSG | OP=typing ON=1|0 | OP=react MSG EMOJI | OP=location (prints LOCATION {Find My location of the space's person}) | OP=download MSG DIR (prints FILES [paths]; a voice memo is transcribed with OPENAI_API_KEY)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { existsSync, statSync } from "node:fs";
import { attachment, markdown, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
const { SPECTRUM_PROJECT_ID: projectId, SPECTRUM_PROJECT_SECRET: projectSecret, OP, SPACE, MSG, TEXT_B64, FILES, ON, EMOJI, DIR } = process.env;
// Big files arrive unreliably as iMessage attachments, so they go up to R2 and the text carries a presigned link.
async function link(path) {
  const { AwsClient } = await import("aws4fetch");
  const r2 = new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const url = `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/raubot-files/${new Date().toISOString().slice(0, 10)}/${Date.now().toString(36)}-${path.split("/").pop()}`;
  const type = { mp4: "video/mp4", mov: "video/quicktime", pdf: "application/pdf", zip: "application/zip" }[path.split(".").pop().toLowerCase()] ?? "application/octet-stream";
  const put = await r2.fetch(url, { method: "PUT", body: await readFile(path), headers: { "content-type": type } });
  if (!put.ok) throw new Error(`R2 upload ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return (await r2.sign(`${url}?X-Amz-Expires=604800`, { aws: { signQuery: true } })).url;
}
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
  const big = files.filter((f) => process.env.R2_SECRET_ACCESS_KEY && statSync(f).size > 5e6);
  const links = await Promise.all(big.map(async (f) => `${f.split("/").pop()}: ${await link(f)}`));
  const text = [Buffer.from(TEXT_B64, "base64").toString("utf8"), ...links].join("\n") + (lost ? `\n(${lost} image${lost > 1 ? "s" : ""} missing)` : "");
  const parts = [...(text.trim() ? [markdown(text)] : []), ...files.filter((f) => !big.includes(f)).map((f) => attachment(f))];
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
    files.push(a.type === "voice" ? `${f} (voice memo, transcribed by speech-to-text, so words and names may be misheard: ${await transcribe(`/workspace/${f}`).catch((e) => `failed, ${e.message}`)})` : f);
  }
  console.log(`FILES ${JSON.stringify(files)}`);
}
else throw new Error(`unknown OP ${OP}`);
process.exit(0);
