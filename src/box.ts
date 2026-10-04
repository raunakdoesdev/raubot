import { DurableObject } from "cloudflare:workers";
import { CAP } from "./prompts.ts";

type Env = { ARTIFACTS: Artifacts; CF_DEPLOY_TOKEN: string };

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
[ -z "$FRESH" ] || [ ! -f setup.sh ] || bash setup.sh`;

/** Files over 10 MB are kept out of git (Artifacts caps files at 32 MB); snapshots keep them. */
const SAVE = `git ls-files -oz --exclude-standard | xargs -0 -r sh -c 'find "$@" -maxdepth 0 -size +10M' _ >> .gitignore; git add -A && { git diff --cached --quiet || git commit -qm "$MSG"; } && { git push -q origin HEAD:main 2>&1 || git pull -q --rebase origin main && git push -q origin HEAD:main; }`;

/** /scratch is for big throwaway files: never in git, emptied before the box stops. */
const WIPE = "rm -rf /scratch/* /scratch/.[!.]*";

export class Computer extends DurableObject<Env> {
	#ready?: Promise<void>;
	#note = "";
	#env: Record<string, string> = {};
	#busy = 0;

	async #run(cmd: string, ms: number, env?: Record<string, string>) {
		const p = await this.ctx.container!.exec(["bash", "-lc", cmd], { cwd: "/workspace", stderr: "combined", signal: AbortSignal.timeout(ms), env: { ...this.#env, ...env } });
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
				CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
			});
			const image = c.images.box;
			const snap = await this.ctx.storage.get<{ id: string; image: string }>("snapshot");
			const restore = !c.running && snap?.image === image;
			const fresh = !c.running && !restore;
			if (!c.running) {
				c.start({ ...(restore ? { containerSnapshot: { id: snap.id } } : { image }), instance: "standard-1", enableInternet: true, env });
				await this.ctx.storage.put("saved", Date.now());
			}
			for (let i = 0; ; i++) {
				try { await this.#run("true", 10_000); break; } catch (e) {
					if (i > 60) {
						if (restore) await this.ctx.storage.delete("snapshot");
						throw e;
					}
					await new Promise((r) => setTimeout(r, 1000));
				}
			}
			await c.setInactivityTimeout(5 * TICK);
			if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK);
			const r = await this.#run(SETUP, 900_000, fresh ? { FRESH: "1" } : {});
			this.#note = r.exitCode ? `[box setup failed]\n${r.out}\n` : "";
		})().catch((e) => { this.#ready = undefined; throw e; }));
	}

	async bash(cmd: string, seconds = 120) {
		this.#busy++;
		try {
			await this.#boot();
			await this.ctx.storage.put("last", Date.now());
			const { out, exitCode } = await this.#run(cmd, seconds * 1000);
			const save = await this.#run(SAVE, 60_000, { MSG: cmd.split("\n")[0].slice(0, 72) });
			const note = this.#note + (save.exitCode ? `\n[autosave failed]\n${save.out}` : "");
			this.#note = "";
			return clip(`${note}${out}\n[exit ${exitCode}]`);
		} catch (e) {
			return clip(`error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.#busy--;
			await this.ctx.storage.put("last", Date.now());
		}
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
