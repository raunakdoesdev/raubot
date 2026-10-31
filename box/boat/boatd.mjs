// raubot's box daemon on a Boat sandbox: runs commands for the Worker's Computer DO.
// Commands, stdin and their env (secrets) arrive in HTTPS request bodies, so they never become Boat command args or history.
// Exposed with `host 8912 --private`; each request also needs the token the Worker wrote to ~/.raubot/boatd.token.
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 8912;
const MAX = 64 << 20;
const TOKEN = `${process.env.HOME}/.raubot/boatd.token`;

const token = () => { try { return fs.readFileSync(TOKEN, "utf8").trim(); } catch { return ""; } };

const body = (req) => new Promise((ok, fail) => {
	const parts = [];
	let n = 0;
	req.on("data", (d) => { n += d.length; if (n > MAX) req.destroy(new Error("body too large")); else parts.push(d); });
	req.on("end", () => ok(Buffer.concat(parts)));
	req.on("error", fail);
});

/** `bash -lc cmd` in /workspace; stdout and stderr combined unless `split`. */
function run({ cmd, env = {}, stdin = "", stdin64, timeout = 120, split = false, cwd = "/workspace" }) {
	return new Promise((ok) => {
		const p = spawn("bash", ["-lc", split ? cmd : `exec 2>&1\n${cmd}`], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		const out = [], err = [];
		let timedOut = false;
		const t = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, "SIGKILL"); } catch {} }, timeout * 1000);
		p.stdout.on("data", (d) => out.push(d));
		p.stderr.on("data", (d) => err.push(d));
		p.stdin.on("error", () => {});
		p.stdin.end(stdin64 ? Buffer.from(stdin64, "base64") : stdin);
		p.on("error", (e) => err.push(Buffer.from(String(e))));
		p.on("close", (code, signal) => {
			clearTimeout(t);
			ok({ out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString(), exitCode: code ?? (signal ? 128 : 1), timedOut });
		});
	});
}

http.createServer(async (req, res) => {
	const json = (status, v) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
	try {
		if (req.url === "/health") return json(200, { ok: true });
		const want = token();
		if (!want || req.headers["x-raubot-token"] !== want) return json(401, { error: "unauthorized" });
		if (req.method === "POST" && req.url === "/exec") {
			const job = run(JSON.parse((await body(req)).toString()));
			// Boat's proxy drops a response with no bytes for 100 s (524), so long commands send a space every 15 s. JSON.parse skips them.
			res.writeHead(200, { "content-type": "application/json" });
			const beat = setInterval(() => res.write(" "), 15_000);
			const r = await job;
			clearInterval(beat);
			return res.end(JSON.stringify(r));
		}
		if (req.url === "/screen") {
			const r = await fetch("http://127.0.0.1:8913/screen").catch(() => undefined);
			if (r?.status !== 200) return json(204, {});
			res.writeHead(200, { "content-type": "image/jpeg", "x-url": r.headers.get("x-url") ?? "" });
			return res.end(Buffer.from(await r.arrayBuffer()));
		}
		json(404, { error: "not found" });
	} catch (e) {
		json(500, { error: String(e) });
	}
}).listen(PORT, "0.0.0.0");
