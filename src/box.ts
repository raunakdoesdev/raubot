import { DurableObject } from "cloudflare:workers";
import { CAP } from "./prompts.ts";

type Env = { GITHUB_TOKEN?: string; CLOUDFLARE_API_TOKEN?: string; CLOUDFLARE_ACCOUNT_ID?: string };

const clip = (s: string) => (s.length <= CAP ? s : `${s.slice(0, CAP / 2)}\n…[${s.length - CAP} chars cut]…\n${s.slice(-CAP / 2)}`);

/** One Linux container holding a clone of raubot's own repo; the agent's bash tool runs here. */
export class Box extends DurableObject<Env> {
	#ready?: Promise<void>;
	#note = "";

	async #run(cmd: string, ms: number) {
		const p = await this.ctx.container!.exec(["bash", "-lc", cmd], { cwd: "/workspace", stderr: "combined", signal: AbortSignal.timeout(ms) });
		const { stdout, exitCode } = await p.output();
		return { out: new TextDecoder().decode(stdout), exitCode };
	}

	#boot() {
		const c = this.ctx.container!;
		if (c.running && this.#ready) return this.#ready;
		if (!c.running) {
			const env: Record<string, string> = {};
			for (const k of ["GITHUB_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const) if (this.env[k]) env[k] = this.env[k]!;
			c.start({ image: c.images.box ?? Object.values(c.images)[0], enableInternet: true, env });
		}
		return (this.#ready = (async () => {
			for (let i = 0; ; i++) {
				try { await this.#run("true", 10_000); break; } catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 1000)); }
			}
			await c.setInactivityTimeout(30 * 60_000);
			const r = await this.#run("/setup.sh", 300_000);
			this.#note = r.exitCode ? `[box setup failed, /workspace/raubot may be missing]\n${r.out}\n` : "";
		})().catch((e) => { this.#ready = undefined; throw e; }));
	}

	async bash(cmd: string, seconds = 120) {
		try {
			await this.#boot();
			const { out, exitCode } = await this.#run(cmd, seconds * 1000);
			const note = this.#note;
			this.#note = "";
			return clip(`${note}${out}\n[exit ${exitCode}]`);
		} catch (e) {
			return clip(`error: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
