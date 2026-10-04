import { DurableObject } from "cloudflare:workers";
import { CAP } from "./prompts.ts";

type Env = { ARTIFACTS: Artifacts };

const clip = (s: string) => (s.length <= CAP ? s : `${s.slice(0, CAP / 2)}\n…[${s.length - CAP} chars cut]…\n${s.slice(-CAP / 2)}`);

/** /workspace is a clone of the Artifacts repo `workspace`, auto-committed and pushed after every command; /workspace/raubot is raubot's own code. */
const SETUP = `set -e
git config --global user.name raubot && git config --global user.email raubot@reducto.ai && git config --global init.defaultBranch main
cd /workspace
[ -d .git ] || { git init -q && git remote add origin "$WORKSPACE_REMOTE" && git fetch -q origin main && git reset -q --hard origin/main && git branch -q -u origin/main; }
git remote set-url origin "$WORKSPACE_REMOTE"
[ -d raubot/.git ] || git clone -q "$RAUBOT_REMOTE" raubot
git -C raubot remote set-url origin "$RAUBOT_REMOTE"
cd raubot && [ -d node_modules ] || npm ci --silent --no-audit --no-fund`;

const SAVE = `git add -A && { git diff --cached --quiet || git commit -qm "$MSG"; } && { git push -q origin HEAD:main 2>&1 || git pull -q --rebase origin main && git push -q origin HEAD:main; }`;

export class Box extends DurableObject<Env> {
	#ready?: Promise<void>;
	#note = "";

	async #run(cmd: string, ms: number, env?: Record<string, string>) {
		const p = await this.ctx.container!.exec(["bash", "-lc", cmd], { cwd: "/workspace", stderr: "combined", signal: AbortSignal.timeout(ms), env });
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
			const env = { WORKSPACE_REMOTE: await this.#remote("workspace"), RAUBOT_REMOTE: await this.#remote("raubot") };
			if (!c.running) c.start({ image: c.images.box ?? Object.values(c.images)[0], enableInternet: true, env });
			for (let i = 0; ; i++) {
				try { await this.#run("true", 10_000); break; } catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 1000)); }
			}
			await c.setInactivityTimeout(30 * 60_000);
			const r = await this.#run(SETUP, 300_000, env);
			this.#note = r.exitCode ? `[box setup failed]\n${r.out}\n` : "";
		})().catch((e) => { this.#ready = undefined; throw e; }));
	}

	async bash(cmd: string, seconds = 120) {
		try {
			await this.#boot();
			const { out, exitCode } = await this.#run(cmd, seconds * 1000);
			const save = await this.#run(SAVE, 60_000, { MSG: cmd.split("\n")[0].slice(0, 72) });
			const note = this.#note + (save.exitCode ? `\n[autosave failed]\n${save.out}` : "");
			this.#note = "";
			return clip(`${note}${out}\n[exit ${exitCode}]`);
		} catch (e) {
			return clip(`error: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
