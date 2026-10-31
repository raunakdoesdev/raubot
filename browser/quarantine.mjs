// node browser/quarantine.mjs [--move]: lists (or moves into "raubot-blocked") the vault items the built-in money list blocks. Names and domains only.
import { quarantine } from "./vault.mjs";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("BW_")));
const host = (u) => { try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`).hostname; } catch { return u; } };
const hit = await quarantine(env, !process.argv.includes("--move"));
for (const h of hit) console.log([h.name, h.reason, [...new Set(h.uris.map(host))].join(" ")].join(" | "));
console.log(`${hit.length} items ${process.argv.includes("--move") ? "moved" : "would move"}`);
