// Sends one iMessage via Spectrum (gRPC, so it runs in the box, not the Worker).
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
const { SPECTRUM_PROJECT_ID: projectId, SPECTRUM_PROJECT_SECRET: projectSecret, SPACE, TEXT_B64 } = process.env;
const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
const space = await imessage(app).space.get(SPACE);
await space.send(Buffer.from(TEXT_B64, "base64").toString("utf8"));
process.exit(0);
