// Boat (boat.dev) sandboxes over its REST API, and the box daemon (box/boat/boatd.mjs) inside one.
// Only non-secret commands go through Boat's command API; anything with secrets goes to the daemon.

const API = "https://boat.dev/api/v1";
export const DAEMON_PORT = 8912;

export class BoatError extends Error {
	constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}

type Sandbox = { id: string; state: string; health?: string };
type Json = Record<string, unknown>;

/** Every box: no account credentials or secrets from Boat (noEnv), no command/output history (monitoring off), default size. */
const SAFE = { type: "default", noEnv: true, monitoring: false };
/** Boat archives a box after this long even if raubot doesn't stop it. */
const TTL = 6 * 3600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Boat {
	constructor(readonly key: string) {}

	async #call<T = Json>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
		let r: Response;
		try {
			r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
		} catch (e) { throw new BoatError(`boat ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`); }
		const j = (await r.json().catch(() => ({}))) as Json & { error?: { code?: string; message?: string } };
		if (!r.ok || j.ok === false) {
			const code = (j.code ?? j.error?.code) as string | undefined;
			throw new BoatError(`boat ${method} ${path}: ${r.status} ${code ?? ""} ${(j.message ?? j.error?.message ?? "") as string}`.trim(), r.status, code);
		}
		return j as T;
	}

	/** A new sandbox from the named snapshot `from` (or Boat's base image). Fails fast when Boat has no ready machine. */
	async create(from?: string) {
		const r = await this.#call<{ sandbox: Sandbox }>("POST", "/sandboxes", { ...SAFE, ttlSeconds: TTL, failFast: true, ...(from ? { from } : {}) }, { "idempotency-key": crypto.randomUUID() });
		return r.sandbox.id;
	}

	/** A copy of `id` from its latest snapshot, also without account credentials. */
	async fork(id: string) {
		const r = await this.#call<{ sandbox: Sandbox }>("POST", `/sandboxes/${id}/fork`, { noEnv: true, monitoring: false, ttlSeconds: TTL, failFast: true });
		return r.sandbox.id;
	}

	/** The sandbox, or undefined when it no longer exists. */
	async get(id: string) {
		try { return (await this.#call<{ sandbox: Sandbox }>("GET", `/sandboxes/${id}`)).sandbox; }
		catch (e) { if (e instanceof BoatError && e.status === 404) return undefined; throw e; }
	}

	resume(id: string) { return this.#call("POST", `/sandboxes/${id}/resume`, { ttlSeconds: TTL, failFast: true }); }
	stop(id: string) { return this.#call("POST", `/sandboxes/${id}/stop`); }
	remove(id: string) { return this.#call("DELETE", `/sandboxes/${id}`, undefined, { "x-ascii-confirm-delete": id }); }

	/** Waits until `id` can run commands; resumes it if it's archived. */
	async ready(id: string, ms = 180_000) {
		const end = Date.now() + ms;
		for (let resumed = false; ; await sleep(1000)) {
			const s = await this.get(id);
			if (!s) throw new BoatError(`boat sandbox ${id} is gone`, 404);
			if (["ready", "idle", "running"].includes(s.state)) return s;
			if (s.state === "error") throw new BoatError(`boat sandbox ${id} is in error`);
			if (s.state === "archived" && !resumed) { await this.resume(id); resumed = true; }
			if (Date.now() > end) throw new BoatError(`boat sandbox ${id} not ready after ${ms / 1000}s (${s.state})`);
		}
	}

	/** Boat's command API. Never for secrets: the command line is sent as-is. */
	async command(id: string, command: string, timeoutSeconds = 60) {
		const r = await this.#call<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>("POST", `/sandboxes/${id}/commands`, { command, timeoutSeconds });
		return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, exitCode: r.exitCode };
	}

	/** Writes a file under /home/user (or /tmp). */
	file(id: string, path: string, content: string) { return this.#call("PUT", `/sandboxes/${id}/files`, { path, content, encoding: "utf8" }); }

	saveSnapshot(id: string, name: string) { return this.#call("POST", "/named-snapshots", { sandboxId: id, name }); }
	async snapshot(name: string) {
		try { return (await this.#call<{ snapshot?: { state?: string; status?: string } } & Json>("GET", `/named-snapshots/${name}`)); }
		catch (e) { if (e instanceof BoatError && e.status === 404) return undefined; throw e; }
	}
}

/** The daemon in one sandbox: its private `host` URL plus raubot's own token. */
export type Daemon = { id: string; url: string; token: string };

/** Exposes the daemon (`host` gives the same URL again after a resume) and gives it a fresh token. */
export async function daemon(boat: Boat, id: string): Promise<Daemon> {
	const h = await boat.command(id, `host ${DAEMON_PORT} --private`, 60);
	const url = /https:\/\/\S+/.exec(h.out)?.[0];
	if (!url) throw new BoatError(`boat host ${DAEMON_PORT}: no URL (exit ${h.exitCode})`);
	const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
	await boat.file(id, ".raubot/boatd.token", token);
	await boat.command(id, "chmod 600 ~/.raubot/boatd.token", 30);
	return { id, url, token };
}

const at = (d: Daemon, path: string) => { const u = new URL(d.url); u.pathname = path; return u.toString(); };

/** Runs `cmd` in the sandbox through its daemon. Throws BoatError when the daemon can't be reached. */
export async function run(d: Daemon, cmd: string, o: { ms: number; env?: Record<string, string>; stdin?: string | Uint8Array; split?: boolean }) {
	const stdin = typeof o.stdin === "string" || o.stdin === undefined ? { stdin: o.stdin ?? "" } : { stdin64: b64(o.stdin) };
	let r: Response;
	try {
		r = await fetch(at(d, "/exec"), {
			method: "POST", headers: { "content-type": "application/json", "x-raubot-token": d.token },
			body: JSON.stringify({ cmd, env: o.env ?? {}, timeout: o.ms / 1000, split: o.split ?? false, ...stdin }),
			signal: AbortSignal.timeout(o.ms + 30_000),
		});
	} catch (e) { throw new BoatError(`box daemon: ${e instanceof Error ? e.message : String(e)}`); }
	if (r.status !== 200) throw new BoatError(`box daemon: ${r.status} ${(await r.text()).slice(0, 300)}`, r.status);
	const j = (await r.json()) as { out: string; err: string; exitCode: number; timedOut: boolean };
	if (j.timedOut) throw new Error(`timed out after ${o.ms / 1000}s`);
	return j;
}

export async function health(d: Daemon, ms = 60_000) {
	const end = Date.now() + ms;
	for (;; await sleep(1000)) {
		const r = await fetch(at(d, "/health"), { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
		if (r?.status === 200) return;
		if (Date.now() > end) throw new BoatError(`box daemon not healthy after ${ms / 1000}s (${r?.status ?? "no answer"})`);
	}
}

export async function screen(d: Daemon) {
	const r = await fetch(at(d, "/screen"), { headers: { "x-raubot-token": d.token }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
	return r?.status === 200 ? { jpeg: new Uint8Array(await r.arrayBuffer()), url: r.headers.get("x-url") ?? "" } : undefined;
}

function b64(bytes: Uint8Array) {
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}
