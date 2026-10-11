// Zero-secrets-at-rest check on a Boat box after a real vault run: `node /workspace/raubot/box/boat/scan.mjs [--files-only]`,
// with BW_CLIENTID, BW_CLIENTSECRET and BW_PASSWORD in the env of this one command only.
// It unlocks the vault in memory (Bitwarden data stays on tmpfs) and makes needles from the master credentials and every vault passkey
// (PKCS#8 DER, base64, base64url, PEM lines, private scalar, credential id as GUID, hex, raw bytes, base64 and base64url).
// Then it greps every file under / (this also reads files Boat restores lazily from the snapshot) and scans the raw root disk.
// Needles reach grep and rawscan.py on stdin, never in a file or argv. Output is names, paths and counts, never values.
// A canary written to the disk on purpose must be found by both scans, so a scan that sees nothing can't pass.
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { logins, passkeys, ready } from "../../browser/vault.mjs";
import { rawId } from "../../browser/passkeys.mjs";

const filesOnly = process.argv.includes("--files-only");
const env = Object.fromEntries(["BW_CLIENTID", "BW_CLIENTSECRET", "BW_PASSWORD"].map((k) => [k, process.env[k]]));
for (const k of Object.keys(env)) delete process.env[k];
if (!ready(env)) throw new Error("BW_CLIENTID, BW_CLIENTSECRET and BW_PASSWORD must be in this command's env");

const needles = [];
const add = (name, b) => { if (b.length >= 12) needles.push({ name, b }); };
const text = (name, s) => {
	for (const f of new Set([s, Buffer.from(s).toString("base64").replace(/=+$/, ""), Buffer.from(s).toString("base64url"), encodeURIComponent(s)])) add(name, Buffer.from(f));
};
for (const [k, v] of Object.entries(env)) text(k, v);
for (const i of await logins(env)) for (const [f, v] of [["username", i.login?.username], ["password", i.login?.password], ["totp seed", i.login?.totp], ["notes", i.notes], ...(i.fields ?? []).map((x) => [x.name, x.value])]) if (v && v.length >= 8) text(`item ${i.name} ${f}`, v);
for (const p of await passkeys(env)) {
	const who = `passkey ${p.rpId}${p.userName ? ` ${p.userName}` : ""}`;
	const der = Buffer.from(p.keyValue, "base64url");
	add(`${who} key der`, der);
	add(`${who} key base64url`, Buffer.from(p.keyValue));
	add(`${who} key base64`, Buffer.from(der.toString("base64").replace(/=+$/, "")));
	const pem = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }).export({ type: "pkcs8", format: "pem" }).toString();
	for (const l of pem.split("\n").filter((l) => l.length === 64)) add(`${who} key pem line`, Buffer.from(l));
	const d = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }).export({ format: "jwk" }).d;
	if (d) { add(`${who} key scalar`, Buffer.from(d, "base64url")); add(`${who} key scalar base64url`, Buffer.from(d)); }
	const id = rawId(p.credentialId);
	add(`${who} credential id`, Buffer.from(p.credentialId));
	add(`${who} credential id raw`, id);
	add(`${who} credential id hex`, Buffer.from(id.toString("hex")));
	add(`${who} credential id base64`, Buffer.from(id.toString("base64").replace(/=+$/, "")));
	add(`${who} credential id base64url`, Buffer.from(id.toString("base64url")));
}
const canary = `canary-${crypto.randomBytes(18).toString("base64url")}`;
add("canary", Buffer.from(canary));
const CANARY = `${process.env.HOME}/.raubot-scan-canary`;
fs.writeFileSync(CANARY, canary);

const sh = (cmd, args, stdin) => new Promise((ok, fail) => {
	const c = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
	let out = "";
	c.stdout.on("data", (d) => (out += d));
	c.on("error", fail);
	c.on("close", () => ok(out));
	c.stdin.end(stdin);
});

const report = { needles: needles.length - 1, passkeys: new Set(needles.filter((n) => n.name.startsWith("passkey")).map((n) => n.name.replace(/ (key|credential id).*$/, ""))).size };
let fail = false;
try {
	await sh("sync", []);
	// grep patterns are lines of text, so the binary forms are left to the raw scan.
	const grepped = needles.filter((n) => !n.b.includes(0x0a) && !n.b.includes(0x00));
	const t = Date.now();
	const files = (await sh("sudo", ["grep", "-rlaF", "-f", "/dev/stdin", "--exclude-dir=proc", "--exclude-dir=sys", "--exclude-dir=dev", "--exclude-dir=run", "/"], grepped.map((n) => n.b.toString()).join("\n") + "\n")).split("\n").filter(Boolean);
	report.files = { s: Math.round((Date.now() - t) / 1000), canaryFound: files.includes(CANARY), secretFiles: files.filter((f) => f !== CANARY) };
	if (!report.files.canaryFound || report.files.secretFiles.length) fail = true;
	if (!filesOnly) {
		const dev = (await sh("findmnt", ["-no", "SOURCE", "/"])).trim();
		const out = `/dev/shm/raubot-rawscan-${crypto.randomBytes(6).toString("hex")}.json`;
		const t2 = Date.now();
		await sh("sudo", ["python3", new URL("./test/rawscan.py", import.meta.url).pathname, dev, "/dev/stdin", out], needles.map((n) => n.b.toString("hex")).join("\n") + "\n");
		const raw = JSON.parse(await sh("sudo", ["cat", out]));
		await sh("sudo", ["rm", "-f", out]);
		const hits = Object.entries(raw.hits).map(([i, c]) => [needles[Number(i)].name, c]);
		report.rawDisk = { device: dev, s: Math.round((Date.now() - t2) / 1000), gb: Math.round(raw.bytes / 1e8) / 10, canaryFound: hits.some(([n]) => n === "canary"), secrets: Object.fromEntries(hits.filter(([n]) => n !== "canary")) };
		if (!report.rawDisk.canaryFound || Object.keys(report.rawDisk.secrets).length) fail = true;
	}
} finally {
	fs.rmSync(CANARY, { force: true });
}
report.pass = !fail;
console.log(JSON.stringify(report, null, 1));
process.exit(fail ? 1 : 0);
