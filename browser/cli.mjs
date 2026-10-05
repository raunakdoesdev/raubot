// Client for server.mjs. `node cli.mjs run` (stdin { code, timeout }) prints the result as JSON.
// `vault find <words>` and `vault run --env NAME=bw://item/field ... -- cmd` are the 2password-style shell commands.
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";

const SOCK = "/tmp/raubot-browser.sock";
const here = (f) => new URL(f, import.meta.url).pathname;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("BW_")));

const call = (op, body = {}) => new Promise((ok, fail) => {
	const req = http.request({ socketPath: SOCK, path: `/${op}`, method: "POST" }, async (res) => {
		let s = "";
		for await (const c of res) s += c;
		const r = JSON.parse(s);
		r.error ? fail(new Error(r.error)) : ok(r.ok);
	});
	req.on("error", fail);
	req.end(JSON.stringify({ ...body, env }));
});

const version = () => ["server.mjs", "vault.mjs", "passkeys.mjs"].map((f) => fs.statSync(here(f)).mtimeMs).join(":");

async function up() {
	const v = await call("version").catch(() => undefined);
	if (v === version()) return;
	if (v) { await call("quit").catch(() => {}); await new Promise((r) => setTimeout(r, 500)); }
	fs.mkdirSync(`${process.env.HOME}/.raubot`, { recursive: true });
	const log = fs.openSync(`${process.env.HOME}/.raubot/browser.log`, "a");
	spawn(process.execPath, [here("server.mjs")], { detached: true, stdio: ["ignore", log, log] }).unref();
	for (let i = 0; i < 100; i++) {
		if ((await call("version").catch(() => undefined)) === version()) return;
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`browser server didn't start: ${fs.readFileSync(`${process.env.HOME}/.raubot/browser.log`, "utf8").slice(-1500)}`);
}

const [cmd, sub, ...rest] = process.argv.slice(2);
try {
	await up();
	if (cmd === "run") {
		let s = "";
		for await (const c of process.stdin) s += c;
		process.stdout.write(JSON.stringify(await call("run", JSON.parse(s))));
	} else if (cmd === "vault" && sub === "find") {
		console.log(JSON.stringify(await call("find", { words: rest }), null, 1));
	} else if (cmd === "vault" && sub === "run") {
		const at = rest.indexOf("--");
		if (at < 0) throw new Error("usage: vault run --env NAME=bw://item/field ... -- command");
		const refs = {};
		for (let i = 0; i < at; i++) if (rest[i] === "--env") { const [k, ...v] = rest[++i].split("="); refs[k] = v.join("="); }
		const values = await call("resolve", { refs });
		const scrub = (s) => Object.entries(values).reduce((s, [k, v]) => (v.length >= 4 ? s.split(v).join(`[${refs[k]}]`) : s), s);
		const p = spawn(rest[at + 1], rest.slice(at + 2), { env: { ...process.env, ...values }, stdio: ["inherit", "pipe", "pipe"] });
		let out = "", err = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		p.on("close", (code) => { process.stdout.write(scrub(out)); process.stderr.write(scrub(err)); process.exit(code ?? 1); });
	} else throw new Error("usage: vault find <words> | vault run --env NAME=bw://item/field ... -- command");
} catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
