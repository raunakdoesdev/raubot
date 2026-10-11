import { DurableObject } from "cloudflare:workers";
import { CAP } from "./prompts.ts";
import { Boat, BoatError, daemon, health, prestop, run, screen, type Daemon } from "./boat.ts";
import { TEMPLATE } from "./boat-template.ts";

type Env = { BOX: DurableObjectNamespace<Computer>; ARTIFACTS: Artifacts; CF_DEPLOY_TOKEN: string; SPECTRUM_PROJECT_ID: string; SPECTRUM_PROJECT_SECRET: string; OIDC_MINT_KEY?: string; PUBLIC_URL?: string; BOX_BACKEND?: string; BOAT_API_KEY?: string; BOAT_TEMPLATE?: string; BOAT_WIPE_BROWSER_ON_STOP?: string };

const ACCOUNT = "fadf1a80d9469afc81af5899893cd853";

/** Snapshot the whole box (installs, datasets, caches) when idle for IDLE, and at most every CHECKPOINT while in use. */
const TICK = 60_000;
const IDLE = 10 * 60_000;
const CHECKPOINT = 15 * 60_000;
/** After a Boat failure the box runs on Cloudflare Containers for this long before trying Boat again. */
const DOWN = 10 * 60_000;
/** A human's take over holds the box's computer use at most this long without a hand back. */
const HOLD = 30 * 60_000;

const clip = (s: string) => (s.length <= CAP ? s : `${s.slice(0, CAP / 2)}\n…[${s.length - CAP} chars cut]…\n${s.slice(-CAP / 2)}`);

/** /workspace is a clone of the Artifacts repo `workspace`, auto-committed and pushed after every command; /workspace/raubot is raubot's own code. */
const SETUP = `set -e
git config --global user.name raubot && git config --global user.email raubot@reducto.ai && git config --global init.defaultBranch main
cd /workspace
[ -d .git ] || { git init -q && git remote add origin "$WORKSPACE_REMOTE" && git fetch -q origin main && git reset -q --hard origin/main && git branch -q -u origin/main; }
git remote set-url origin "$WORKSPACE_REMOTE"
grep -qx raubot/ .gitignore 2>/dev/null || { printf 'raubot/\nnode_modules/\n' >> .gitignore; git rm -rq --cached --ignore-unmatch raubot; }
[ -d raubot/.git ] || git clone -q "$RAUBOT_REMOTE" raubot
git -C raubot remote set-url origin "$RAUBOT_REMOTE"
git -C raubot pull -q --ff-only 2>/dev/null || true
(cd raubot && [ -d node_modules ] || npm ci --silent --no-audit --no-fund)
mkdir -p /scratch
(cd raubot/browser 2>/dev/null && { [ -d node_modules ] || npm i -s --no-audit --no-fund; } && ln -sf "$PWD/vault" /usr/local/bin/vault) || true
[ -z "$FRESH" ] || [ ! -f setup.sh ] || bash setup.sh`;

/** A Boat box's remotes carry no token: git gets it per command from GIT_CONFIG_* env, so it's never on the box's disk. */
const gitAuth = (remotes: { url: string; token: string }[]) => Object.fromEntries([["GIT_CONFIG_COUNT", String(remotes.length)],
	...remotes.flatMap(({ url, token }, i) => [[`GIT_CONFIG_KEY_${i}`, `http.${url}.extraHeader`], [`GIT_CONFIG_VALUE_${i}`, `Authorization: Basic ${btoa(`x:${token}`)}`]])]);

/** Files over 10 MB are kept out of git (Artifacts caps files at 32 MB); snapshots keep them. */
const COMMIT = `git ls-files -oz --exclude-standard | xargs -0 -r sh -c 'find "$@" -maxdepth 0 -size +10M' _ >> .gitignore; git add -A && { git diff --cached --quiet || git commit -qm "$MSG"; }`;
/** The main box pulls first, so subagents' merged work shows up in /workspace. */
const SAVE = `${COMMIT} && git pull -q --rebase origin main 2>&1 && git push -q origin HEAD:main 2>&1`;

/** A subagent's box (agent-<id>) works on its own branch, pushed after every command and merged into main when it replies. */
const SAVE_AGENT = `${COMMIT} && git push -q -f origin HEAD:refs/heads/$BRANCH 2>&1`;
const SYNC = `git checkout -q -B "$BRANCH" && git fetch -q origin main && { git rebase -q origin/main >/dev/null 2>&1 || { git rebase --abort; echo "[couldn't rebase $BRANCH onto workspace main]"; }; }`;
const MERGE = `for i in 1 2 3; do
git fetch -q origin main && git rebase -q origin/main >/dev/null 2>&1 || { echo "conflicts with workspace main in:"; git diff --name-only --diff-filter=U; git rebase --abort; exit 1; }
git push -q origin HEAD:main 2>&1 && exit 0
done; exit 1`;

/** /scratch is for big throwaway files: never in git, emptied before the box stops. */
const WIPE = "rm -rf /scratch/* /scratch/.[!.]*";

/** A timeout signal that is cleared when the command ends: an abort that fires after an exec finished throws an internal error. */
const deadline = (ms: number) => {
	const c = new AbortController(), t = setTimeout(() => c.abort(new Error(`timed out after ${ms / 1000}s`)), ms);
	return { signal: c.signal, [Symbol.dispose]: () => clearTimeout(t) };
};

export class Computer extends DurableObject<Env> {
	#ready?: Promise<void>;
	#note = "";
	#env: Record<string, string> = {};
	#busy = 0;
	#git: Promise<unknown> = Promise.resolve();
	/** Set while this box runs on Boat: its sandbox's daemon. */
	#boat?: Daemon;
	/** Computer-use calls waiting for a human to hand the desktop back. */
	#waiters: (() => void)[] = [];
	/** A Boat boot is under way (the container isn't running yet). */
	#up = false;

	/** "agent-<id>" for a subagent's box, undefined for raubot's own. */
	get #agent() { const n = this.ctx.id.name; return n && n !== "main" ? n : undefined; }

	get #running() { return !!this.#boat || this.ctx.container!.running; }

	/** Git runs one at a time per box, so parallel commands don't collide on index.lock. */
	#serial<T>(f: () => Promise<T>) {
		const p = this.#git.then(f);
		this.#git = p.catch(() => {});
		return p;
	}

	/** Runs `cmd` in /workspace on whichever backend the box is on; stdout and stderr combined unless `split`. */
	async #exec(cmd: string, o: { ms: number; env?: Record<string, string>; stdin?: string | Uint8Array; split?: boolean }) {
		const env = { ...this.#env, ...o.env };
		if (this.#boat) {
			try { return await run(this.#boat, cmd, { ...o, env }); }
			catch (e) { if (e instanceof BoatError) this.#lost(); throw e; }
		}
		using t = deadline(o.ms);
		const p = await this.ctx.container!.exec(["bash", "-lc", cmd], {
			cwd: "/workspace", signal: t.signal, env,
			...(o.stdin === undefined ? {} : { stdin: new Blob([o.stdin]).stream() }),
			...(o.split ? { stdout: "pipe", stderr: "pipe" } : { stderr: "combined" }),
		});
		const { stdout, stderr, exitCode } = await p.output();
		const d = new TextDecoder();
		return { out: d.decode(stdout), err: stderr ? d.decode(stderr) : "", exitCode };
	}

	async #run(cmd: string, ms: number, env?: Record<string, string>) {
		const { out, exitCode } = await this.#exec(cmd, { ms, env });
		return { out, exitCode };
	}

	/** The Boat sandbox stopped answering: boot again (Boat or the fallback) on the next call. */
	#lost() { this.#boat = undefined; this.#ready = undefined; this.#up = false; }

	/** Boat when this deployment uses it and it hasn't failed in the last DOWN. */
	async #boatApi() {
		if (this.env.BOX_BACKEND !== "boat" || !this.env.BOAT_API_KEY) return undefined;
		return ((await this.ctx.storage.get<number>("boatDown")) ?? 0) > Date.now() ? undefined : new Boat(this.env.BOAT_API_KEY);
	}

	async #remote(name: string) {
		using repo = await this.env.ARTIFACTS.get(name);
		const { remote } = await repo.info();
		const { plaintext } = await repo.createToken("write", 7 * 86_400);
		return { url: remote, token: plaintext.split("?expires=")[0] };
	}

	#boot() {
		if (this.#ready && (this.#up || this.#running)) return this.#ready;
		return (this.#ready = (async () => {
			const boat = await this.#boatApi();
			this.#up = !!boat;
			const [ws, rb] = [await this.#remote("workspace"), await this.#remote("raubot")];
			const base = {
				CLOUDFLARE_API_TOKEN: this.env.CF_DEPLOY_TOKEN,
				SPECTRUM_PROJECT_ID: this.env.SPECTRUM_PROJECT_ID,
				SPECTRUM_PROJECT_SECRET: this.env.SPECTRUM_PROJECT_SECRET,
				CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
				// Mints Reducto Access agent tokens via POST /s/oidc/token (see raubot-oidc). The signing key stays in the Worker.
				...(this.env.OIDC_MINT_KEY ? { RAUBOT_OIDC_MINT_KEY: this.env.OIDC_MINT_KEY, RAUBOT_URL: this.env.PUBLIC_URL ?? "https://raubot.reducto.ai" } : {}),
				...(this.#agent ? { BRANCH: this.#agent } : {}),
			};
			let fresh = false;
			if (boat) {
				try {
					this.#env = { ...base, WORKSPACE_REMOTE: ws.url, RAUBOT_REMOTE: rb.url, ...gitAuth([ws, rb]) };
					this.#boat = await this.#boatUp(boat);
				} catch (e) {
					console.log("box boat failed", JSON.stringify({ box: this.ctx.id.name, error: String(e) }));
					await this.ctx.storage.put("boatDown", Date.now() + DOWN);
					this.#boat = undefined;
					this.#note += `[box: Boat is unavailable (${e instanceof Error ? e.message : String(e)}); this box is on the Cloudflare fallback for now]\n`;
				}
			}
			if (!this.#boat) {
				const auth = (r: { url: string; token: string }) => `https://x:${r.token}@${r.url.slice("https://".length)}`;
				this.#env = { ...base, WORKSPACE_REMOTE: auth(ws), RAUBOT_REMOTE: auth(rb) };
				fresh = await this.#cfUp();
				this.#up = false;
			}
			if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK);
			// On Boat installs persist on the disk, so setup.sh is only replayed for a fresh Cloudflare box.
			const r = await this.#run(SETUP, 900_000, fresh ? { FRESH: "1" } : {});
			this.#note += r.exitCode ? `[box setup failed]\n${r.out}\n` : "";
			if (this.#agent) this.#note += (await this.#serial(() => this.#run(SYNC, 120_000))).out;
		})().catch((e) => { this.#lost(); throw e; }));
	}

	/** Starts (or resumes, or forks for a subagent) this box's Boat sandbox and connects to its daemon. */
	async #boatUp(boat: Boat) {
		const t = Date.now();
		const zdr = await boat.zdr();
		await this.ctx.storage.put("zdr", zdr);
		let rec = await this.ctx.storage.get<Daemon>("boat");
		if (rec) {
			const s = await boat.get(rec.id);
			// With zero data retention a stop erases the sandbox, so an archived one can't come back.
			const erased = !!s && zdr && ["archiving", "archived"].includes(s.state);
			if (erased) await boat.remove(rec.id).catch(() => {});
			if (!s || erased) { rec = undefined; await this.ctx.storage.delete("boat"); }
		}
		let how = rec ? "resume" : "fork";
		if (!rec) {
			// A subagent's box is a fork of raubot's (with no Boat credentials either); raubot's starts from the template.
			const from = this.#agent ? await (this.env.BOX.getByName("main") as unknown as { boatId(): Promise<string | undefined> }).boatId() : undefined;
			if (this.#agent && !from) throw new BoatError("raubot's box isn't on Boat");
			// Boat forks from the latest disk snapshot. A sandbox that just started has none yet, so then the subagent starts clean.
			let id = from ? await boat.fork(from).catch((e) => { if (e instanceof BoatError && e.code === "fork_failed") return undefined; throw e; }) : undefined;
			if (!id) {
				how = this.env.BOAT_TEMPLATE ? "template" : "install";
				// raubot's box doesn't auto-stop when a stop would erase it.
				id = await boat.create(this.env.BOAT_TEMPLATE || undefined, !this.#agent && zdr);
			}
			rec = { id, url: "", token: "" };
			await this.ctx.storage.put("boat", rec);
			if (how === "install") { await boat.ready(id); await boat.bootstrap(id, TEMPLATE); }
		}
		const s = await boat.ready(rec.id);
		if (!rec.url) await this.ctx.storage.put("boat", (rec = await daemon(boat, rec.id)));
		await health(rec);
		// Boat recreates its /swapfile on resume; swapped-out memory would put vault values on the root disk.
		await run(rec, "sudo swapoff -a && sudo rm -f /swapfile", { ms: 30_000 });
		await this.ctx.storage.put("saved", Date.now());
		console.log("box boot", JSON.stringify({ box: this.ctx.id.name, backend: "boat", id: rec.id, how, zdr, state: s.state, ms: Date.now() - t }));
		return rec;
	}

	/** Starts the Cloudflare container, from its snapshot when there is one. True when it started from nothing. */
	async #cfUp() {
		const c = this.ctx.container!;
		const image = c.images.box;
		const own = await this.ctx.storage.get<{ id: string; image: string }>("snapshot");
		// A new subagent box starts as a copy of raubot's box: its last snapshot.
		const snap = own ?? (this.#agent && !c.running ? (await (this.env.BOX.getByName("main") as unknown as { status(): Promise<{ snapshot?: typeof own }> }).status()).snapshot : undefined);
		const restore = !c.running && snap?.image === image;
		const fresh = !c.running && !restore;
		console.log("box boot", JSON.stringify({ box: this.ctx.id.name, backend: "cf", running: c.running, restore, fork: restore && !own, fresh }));
		if (!c.running) {
			c.start({ ...(restore ? { containerSnapshot: { id: snap.id } } : { image }), instance: "standard-1", enableInternet: true, env: this.#env });
			await this.ctx.storage.put("saved", Date.now());
		}
		for (let i = 0; ; i++) {
			try { await this.#run("true", 10_000); break; } catch (e) {
				console.log("box exec not ready", JSON.stringify({ i, running: c.running, restore, error: String(e) }));
				if (i > 60) {
					if (restore && own) await this.ctx.storage.delete("snapshot");
					throw e;
				}
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
		await c.setInactivityTimeout(5 * TICK);
		return fresh;
	}

	/** raubot's Boat sandbox, booted if needed, for a subagent's box to fork; undefined when raubot's box is on the fallback. */
	async boatId() {
		await this.#boot();
		return this.#boat?.id;
	}

	/** Boots, then runs `f`; if Boat drops mid-call, boots again (Boat or the fallback) and retries once. */
	async #on<T>(f: () => Promise<T>) {
		await this.#boot();
		try { return await f(); }
		catch (e) {
			if (!(e instanceof BoatError)) throw e;
			console.log("box boat lost", JSON.stringify({ box: this.ctx.id.name, error: String(e) }));
			await this.#boot();
			return f();
		}
	}

	/** `env` is for this command only (secrets): it never reaches the box's own env, git or snapshots. */
	async bash(cmd: string, seconds = 120, env?: Record<string, string>) {
		this.#busy++;
		try {
			await this.ctx.storage.put("last", Date.now());
			const { out, exitCode } = await this.#on(() => this.#run(cmd, seconds * 1000, env));
			const save = await this.#serial(() => this.#run(this.#agent ? SAVE_AGENT : SAVE, 60_000, { MSG: cmd.split("\n")[0].slice(0, 72) }));
			const note = this.#note + (save.exitCode ? `\n[autosave failed]\n${save.out}` : "");
			this.#note = "";
			return clip(`${note}${out}\n[exit ${exitCode}]`);
		} catch (e) {
			console.log("box bash failed", String(e));
			return clip(`error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.#busy--;
			await this.ctx.storage.put("last", Date.now());
		}
	}

	/** Runs `cmd` with `stdin`, keeping stdout and stderr apart; nothing is clipped or committed. */
	async exec(cmd: string, stdin: string, seconds: number, env?: Record<string, string>) {
		this.#busy++;
		try {
			await this.ctx.storage.put("last", Date.now());
			return await this.#on(() => this.#exec(cmd, { ms: seconds * 1000, env, stdin, split: true }));
		} finally {
			this.#busy--;
			await this.ctx.storage.put("last", Date.now());
		}
	}

	/** Writes a file into the box; `path` is relative to /workspace. */
	async write(path: string, bytes: Uint8Array) {
		await this.ctx.storage.put("last", Date.now());
		const r = await this.#on(() => this.#exec('mkdir -p "$(dirname "$F")" && cat > "$F"', { ms: 120_000, env: { F: path }, stdin: bytes }));
		if (r.exitCode) throw new Error(`write ${path}: ${r.out}`);
	}

	/** Subagent box: commit and merge its branch into workspace main. "" when merged (or never used), else why not. */
	async merge() {
		if (!this.#agent || !(await this.ctx.storage.get("last"))) return "";
		this.#busy++;
		try {
			const r = await this.#on(() => this.#serial(async () => {
				await this.#run(SAVE_AGENT, 60_000, { MSG: "subagent reply" });
				return this.#run(MERGE, 120_000);
			}));
			console.log("box merge", JSON.stringify({ box: this.#agent, exit: r.exitCode }));
			// Merged work is in workspace main, so a Boat fork is deleted; the next task forks raubot's box again.
			if (!r.exitCode && this.#boat) await this.#drop();
			return r.exitCode ? r.out.trim() || "merge failed" : "";
		} finally {
			this.#busy--;
			await this.ctx.storage.put("last", Date.now());
		}
	}

	/** raubot's box: pull subagents' merged work into /workspace now, if it's up. */
	async pull() {
		if (this.#agent || !this.#running) return;
		await this.#on(() => this.#serial(() => this.#run(`${COMMIT} && git pull -q --rebase origin main 2>&1`, 60_000, { MSG: "before pulling subagent work" })));
	}

	async #snapshot() {
		const c = this.ctx.container!;
		const saved = Date.now();
		const { id, size } = await c.snapshotContainer({ name: "box" });
		await this.ctx.storage.put({ snapshot: { id, size, image: c.images.box }, saved });
	}

	/** Stops the Boat sandbox (Boat snapshots its disk; a stopped sandbox costs nothing). */
	async #boatStop() {
		const rec = await this.ctx.storage.get<Daemon>("boat");
		if (this.#boat) await this.#run(prestop(this.env.BOAT_WIPE_BROWSER_ON_STOP === "1"), 60_000).catch(() => {});
		this.#lost();
		if (rec && this.env.BOAT_API_KEY) await new Boat(this.env.BOAT_API_KEY).stop(rec.id).catch((e) => console.log("box boat stop", String(e)));
		await this.ctx.storage.put("saved", Date.now());
	}

	/** Deletes this box's Boat sandbox for good. */
	async #drop() {
		const rec = await this.ctx.storage.get<Daemon>("boat");
		this.#lost();
		await this.ctx.storage.delete("boat");
		if (rec && this.env.BOAT_API_KEY) await new Boat(this.env.BOAT_API_KEY).remove(rec.id).catch((e) => console.log("box boat delete", String(e)));
	}

	/** Snapshot and stop the box now (debug: POST /box). */
	async stop() {
		const c = this.ctx.container!;
		if (await this.ctx.storage.get("boat")) await this.#boatStop();
		if (c.running) {
			await this.#run(WIPE, 60_000);
			await this.#snapshot();
			this.#ready = undefined;
			await c.destroy("stop");
		}
		return this.status();
	}

	/** Stop the box and forget its snapshot (and delete its Boat sandbox); the next call starts fresh from git. */
	async reset() {
		const c = this.ctx.container!;
		if (c.running) await c.destroy("reset");
		await this.#drop();
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}
	/** Browser logins every box shares, kept on the main box: cookies by domain, the newest push wins. */
	async jar() {
		const all = await this.ctx.storage.list<unknown[]>({ prefix: "jar:" });
		return Object.fromEntries([...all].map(([k, v]) => [k.slice(4), v]));
	}

	async jarPut(changed: Record<string, unknown[]>) {
		for (const [d, cs] of Object.entries(changed)) await (cs.length ? this.ctx.storage.put(`jar:${d}`, cs) : this.ctx.storage.delete(`jar:${d}`));
	}

	/** A new desktop URL for a human to drive this box (Boat only; undefined on the fallback). Holds its computer use until release(). Never boots a subagent box that has no sandbox. */
	async desktop() {
		if (this.#agent && !(await this.ctx.storage.get("boat"))) return undefined;
		await this.#boot();
		if (!this.#boat || !this.env.BOAT_API_KEY) return undefined;
		const url = await new Boat(this.env.BOAT_API_KEY).desktop(this.#boat.id);
		await this.ctx.storage.put({ held: Date.now() + HOLD, last: Date.now() });
		return url;
	}

	/** The human hands the desktop back: waiting computer-use calls go on. */
	async release() {
		await this.ctx.storage.delete("held");
		for (const w of this.#waiters.splice(0)) w();
	}

	async #held() { return Math.max(0, ((await this.ctx.storage.get<number>("held")) ?? 0) - Date.now()); }

	/** Waits (at most `ms`) while a human holds the desktop. Resolves with whether it's still held. */
	async free(ms = HOLD) {
		const left = await this.#held();
		if (!left) return false;
		await new Promise<void>((ok) => {
			const t = setTimeout(ok, Math.min(ms, left));
			this.#waiters.push(() => { clearTimeout(t); ok(); });
		});
		return (await this.#held()) > 0;
	}

	/** The live view: the browser's current tab, or undefined when the box or its browser isn't running. Never starts the box. */
	async screen() {
		if (this.#boat) return screen(this.#boat);
		const c = this.ctx.container!;
		if (!c.running) return undefined;
		const r = await c.getTcpPort(8090).fetch("http://box/screen").catch(() => undefined);
		return r?.status === 200 ? { jpeg: new Uint8Array(await r.arrayBuffer()), url: r.headers.get("x-url") ?? "" } : undefined;
	}

	async status() {
		const [snapshot, last, saved, boat, boatDown, held, alarm] = await Promise.all(["snapshot", "last", "saved", "boat", "boatDown", "held"].map((k) => this.ctx.storage.get(k)).concat(this.ctx.storage.getAlarm()));
		return { backend: this.#boat ? "boat" : this.ctx.container!.running ? "cf" : undefined, running: this.#running, boat: (boat as Daemon | undefined)?.id, boatDown, held: ((held as number | undefined) ?? 0) > Date.now(), images: this.ctx.container!.images, snapshot, last, saved, alarm };
	}

	async alarm() {
		const c = this.ctx.container!;
		const now = Date.now();
		const last = (await this.ctx.storage.get<number>("last")) ?? 0;
		// Boat snapshots the disk every minute by itself; raubot only stops the sandbox when it's idle.
		if (!c.running && (await this.ctx.storage.get("boat"))) {
			if (this.#busy || now - last <= IDLE || (await this.#held())) return this.ctx.storage.setAlarm(now + TICK);
			// With zero data retention a stop erases the disk: raubot's box keeps running, and an idle subagent box is deleted (its work is pushed).
			if (await this.ctx.storage.get("zdr")) return this.#agent ? this.#drop() : undefined;
			if ((await this.ctx.storage.get<number>("saved") ?? 0) < last || this.#boat) await this.#boatStop();
			return;
		}
		if (!c.running) return;
		const saved = (await this.ctx.storage.get<number>("saved")) ?? 0;
		const idle = !this.#busy && now - last > IDLE;
		if (idle) await this.#run(WIPE, 60_000);
		if (idle || (!this.#busy && last > saved && now - saved > CHECKPOINT)) await this.#snapshot();
		if (idle && !this.#busy && (await this.ctx.storage.get<number>("last")) === last) {
			this.#ready = undefined;
			return c.destroy("idle");
		}
		await c.setInactivityTimeout(5 * TICK);
		await this.ctx.storage.setAlarm(Date.now() + TICK);
	}
}
