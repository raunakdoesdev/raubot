import { DurableObject } from "cloudflare:workers";
import { CAP } from "./prompts.ts";

type Env = { BOX: DurableObjectNamespace<Computer>; ARTIFACTS: Artifacts; CF_DEPLOY_TOKEN: string; SPECTRUM_PROJECT_ID: string; SPECTRUM_PROJECT_SECRET: string };

const ACCOUNT = "fadf1a80d9469afc81af5899893cd853";

/** Snapshot the whole box (installs, datasets, caches) when idle for IDLE, and at most every CHECKPOINT while in use. */
const TICK = 60_000;
const IDLE = 10 * 60_000;
const CHECKPOINT = 15 * 60_000;

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

	/** "agent-<id>" for a subagent's box, undefined for raubot's own. */
	get #agent() { const n = this.ctx.id.name; return n && n !== "main" ? n : undefined; }

	/** Git runs one at a time per box, so parallel commands don't collide on index.lock. */
	#serial<T>(f: () => Promise<T>) {
		const p = this.#git.then(f);
		this.#git = p.catch(() => {});
		return p;
	}

	async #run(cmd: string, ms: number, env?: Record<string, string>) {
		using t = deadline(ms);
		const p = await this.ctx.container!.exec(["bash", "-lc", cmd], { cwd: "/workspace", stderr: "combined", signal: t.signal, env: { ...this.#env, ...env } });
		const { stdout, exitCode } = await p.output();
		return { out: new TextDecoder().decode(stdout), exitCode };
	}

	async #remote(name: string) {
		using repo = await this.env.ARTIFACTS.get(name);
		const { remote } = await repo.info();
		const { plaintext } = await repo.createToken("write", 7 * 86_400);
		return `https://x:${plaintext.split("?expires=")[0]}@${remote.slice("https://".length)}`;
	}

	#boot() {
		const c = this.ctx.container!;
		if (c.running && this.#ready) return this.#ready;
		return (this.#ready = (async () => {
			const env = (this.#env = {
				WORKSPACE_REMOTE: await this.#remote("workspace"),
				RAUBOT_REMOTE: await this.#remote("raubot"),
				CLOUDFLARE_API_TOKEN: this.env.CF_DEPLOY_TOKEN,
				SPECTRUM_PROJECT_ID: this.env.SPECTRUM_PROJECT_ID,
				SPECTRUM_PROJECT_SECRET: this.env.SPECTRUM_PROJECT_SECRET,
				CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
				...(this.#agent ? { BRANCH: this.#agent } : {}),
			});
			const image = c.images.box;
			const own = await this.ctx.storage.get<{ id: string; image: string }>("snapshot");
			// A new subagent box starts as a copy of raubot's box: its last snapshot.
			const snap = own ?? (this.#agent && !c.running ? (await (this.env.BOX.getByName("main") as unknown as { status(): Promise<{ snapshot?: typeof own }> }).status()).snapshot : undefined);
			const restore = !c.running && snap?.image === image;
			const fresh = !c.running && !restore;
			console.log("box boot", JSON.stringify({ box: this.ctx.id.name, running: c.running, restore, fork: restore && !own, fresh }));
			if (!c.running) {
				c.start({ ...(restore ? { containerSnapshot: { id: snap.id } } : { image }), instance: "standard-1", enableInternet: true, env });
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
			if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK);
			const r = await this.#run(SETUP, 900_000, fresh ? { FRESH: "1" } : {});
			this.#note = r.exitCode ? `[box setup failed]\n${r.out}\n` : "";
			if (this.#agent) this.#note += (await this.#serial(() => this.#run(SYNC, 120_000))).out;
		})().catch((e) => { this.#ready = undefined; throw e; }));
	}

	/** `env` is for this command only (secrets): it never reaches the box's own env, git or snapshots. */
	async bash(cmd: string, seconds = 120, env?: Record<string, string>) {
		this.#busy++;
		try {
			await this.#boot();
			await this.ctx.storage.put("last", Date.now());
			const { out, exitCode } = await this.#run(cmd, seconds * 1000, env);
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
			await this.#boot();
			await this.ctx.storage.put("last", Date.now());
			using t = deadline(seconds * 1000);
			const p = await this.ctx.container!.exec(["bash", "-lc", cmd], { cwd: "/workspace", stdin: new Blob([stdin]).stream(), stdout: "pipe", stderr: "pipe", signal: t.signal, env: { ...this.#env, ...env } });
			const { stdout, stderr, exitCode } = await p.output();
			const d = new TextDecoder();
			return { out: d.decode(stdout), err: d.decode(stderr), exitCode };
		} finally {
			this.#busy--;
			await this.ctx.storage.put("last", Date.now());
		}
	}

	/** Writes a file into the box; `path` is relative to /workspace. */
	async write(path: string, bytes: Uint8Array) {
		await this.#boot();
		await this.ctx.storage.put("last", Date.now());
		using t = deadline(120_000);
		const p = await this.ctx.container!.exec(["bash", "-c", 'mkdir -p "$(dirname "$F")" && cat > "$F"'], { cwd: "/workspace", stdin: new Blob([bytes]).stream(), stderr: "combined", env: { ...this.#env, F: path }, signal: t.signal });
		const { stdout, exitCode } = await p.output();
		if (exitCode) throw new Error(`write ${path}: ${new TextDecoder().decode(stdout)}`);
	}

	/** Subagent box: commit and merge its branch into workspace main. "" when merged (or never used), else why not. */
	async merge() {
		if (!this.#agent || !(await this.ctx.storage.get("last"))) return "";
		this.#busy++;
		try {
			await this.#boot();
			const r = await this.#serial(async () => {
				await this.#run(SAVE_AGENT, 60_000, { MSG: "subagent reply" });
				return this.#run(MERGE, 120_000);
			});
			console.log("box merge", JSON.stringify({ box: this.#agent, exit: r.exitCode }));
			return r.exitCode ? r.out.trim() || "merge failed" : "";
		} finally {
			this.#busy--;
			await this.ctx.storage.put("last", Date.now());
		}
	}

	/** raubot's box: pull subagents' merged work into /workspace now, if it's up. */
	async pull() {
		if (this.#agent || !this.ctx.container!.running) return;
		await this.#boot();
		await this.#serial(() => this.#run(`${COMMIT} && git pull -q --rebase origin main 2>&1`, 60_000, { MSG: "before pulling subagent work" }));
	}

	async #snapshot() {
		const c = this.ctx.container!;
		const saved = Date.now();
		const { id, size } = await c.snapshotContainer({ name: "box" });
		await this.ctx.storage.put({ snapshot: { id, size, image: c.images.box }, saved });
	}

	/** Snapshot and stop the box now (debug: POST /box). */
	async stop() {
		const c = this.ctx.container!;
		if (c.running) {
			await this.#run(WIPE, 60_000);
			await this.#snapshot();
			this.#ready = undefined;
			await c.destroy("stop");
		}
		return this.status();
	}

	/** Stop the box and forget its snapshot; the next call starts fresh from git. */
	async reset() {
		const c = this.ctx.container!;
		if (c.running) await c.destroy("reset");
		this.#ready = undefined;
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	async status() {
		const [snapshot, last, saved, alarm] = await Promise.all(["snapshot", "last", "saved"].map((k) => this.ctx.storage.get(k)).concat(this.ctx.storage.getAlarm()));
		return { running: this.ctx.container!.running, images: this.ctx.container!.images, snapshot, last, saved, alarm };
	}

	async alarm() {
		const c = this.ctx.container!;
		if (!c.running) return;
		const now = Date.now();
		const last = (await this.ctx.storage.get<number>("last")) ?? 0;
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
