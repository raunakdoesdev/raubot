// One iMessage action via Spectrum (gRPC, so it runs in the box, not the Worker).
// OP=send TEXT_B64 (markdown, rendered as iMessage styled text) [FILES: JSON list of box paths, sent as attachments] | OP=read MSG | OP=typing ON=1|0 | OP=react MSG EMOJI | OP=download MSG DIR (prints FILES [paths])
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { attachment, markdown, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
const { SPECTRUM_PROJECT_ID: projectId, SPECTRUM_PROJECT_SECRET: projectSecret, OP, SPACE, MSG, TEXT_B64, FILES, ON, EMOJI, DIR } = process.env;
const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
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
else if (OP === "react") await (await message()).react(EMOJI);
else if (OP === "download") {
  const { content } = await message();
  const parts = content.type === "group" ? content.items.map((i) => i.content) : [content];
  await mkdir(`/workspace/${DIR}`, { recursive: true });
  const files = [];
  for (const a of parts.filter((p) => p.type === "attachment")) {
    const f = `${DIR}/${Date.now().toString(36)}-${a.name.replace(/[^\w.-]+/g, "_").slice(-80)}`;
    await writeFile(`/workspace/${f}`, await a.read());
    files.push(f);
  }
  console.log(`FILES ${JSON.stringify(files)}`);
}
else throw new Error(`unknown OP ${OP}`);
process.exit(0);
