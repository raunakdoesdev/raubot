// One iMessage action via Spectrum (gRPC, so it runs in the box, not the Worker).
// OP=send TEXT_B64 | OP=read MSG | OP=typing ON=1|0 | OP=react MSG EMOJI
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
const { SPECTRUM_PROJECT_ID: projectId, SPECTRUM_PROJECT_SECRET: projectSecret, OP, SPACE, MSG, TEXT_B64, ON, EMOJI } = process.env;
const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
const space = await imessage(app).space.get(SPACE);
const message = async () => (await space.getMessage(MSG)) ?? Promise.reject(new Error(`no message ${MSG}`));
if (OP === "send") await space.send(Buffer.from(TEXT_B64, "base64").toString("utf8"));
else if (OP === "read") await (await message()).read();
else if (OP === "typing") await (ON === "1" ? space.startTyping() : space.stopTyping());
else if (OP === "react") await (await message()).react(EMOJI);
else throw new Error(`unknown OP ${OP}`);
process.exit(0);
