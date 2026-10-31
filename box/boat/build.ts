// Builds the Boat template for fresh raubot boxes from manifest.json: a clean sandbox, install.sh, then a named snapshot.
// Usage: BOAT_API_KEY=... npx tsx box/boat/build.ts   (prints the snapshot name for BOAT_TEMPLATE)
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Boat } from "../../src/core/boat.ts";

const DIR = new URL(".", import.meta.url).pathname;
const FILES = ["manifest.json", "install.sh", "boatd.mjs", "firewall.sh", "raubot-boatd.service", "raubot-firewall.service"];

const key = process.env.BOAT_API_KEY;
if (!key) throw new Error("BOAT_API_KEY isn't set");
const boat = new Boat(key);
const hash = createHash("sha256");
for (const f of FILES) hash.update(f).update(fs.readFileSync(DIR + f));
const name = `raubot-box-${hash.digest("hex").slice(0, 10)}`;

const ready = async () => {
	const s = await boat.snapshot(name);
	const state = (s?.snapshot as { state?: string; status?: string } | undefined) ?? (s as { state?: string; status?: string } | undefined);
	return state?.state ?? state?.status;
};

if ((await ready()) === "ready") { console.log(name); process.exit(0); }
const t = Date.now();
const id = await boat.create();
console.error(`builder ${id}`);
try {
	await boat.ready(id);
	for (const f of FILES) await boat.file(id, `.raubot-template/${f}`, fs.readFileSync(DIR + f, "utf8"));
	const r = await boat.command(id, "sudo bash .raubot-template/install.sh", 600);
	console.error(r.out.slice(-3000));
	if (r.exitCode) throw new Error(`install.sh exited ${r.exitCode}`);
	await boat.command(id, "rm -rf .raubot-template", 30);
	await boat.saveSnapshot(id, name);
	for (let s; (s = await ready()) !== "ready"; await new Promise((r) => setTimeout(r, 3000)))
		if (s === "failed" || s === "error") throw new Error(`snapshot ${name} ${s}`);
	console.error(`built ${name} in ${Math.round((Date.now() - t) / 1000)}s`);
	console.log(name);
} finally {
	await boat.remove(id).catch((e) => console.error(`couldn't delete builder ${id}: ${e}`));
}
