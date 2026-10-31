import type { Computer } from "./core/box.ts";
import type { Raubot } from "./core/raubot.ts";
import { edge, type EdgeEnv } from "./app/index.ts";
import { gate } from "./app/access.ts";
import { BUILD_HEADER, buildOf } from "./core/agents.ts";
export { Computer } from "./core/box.ts";
export { Raubot } from "./core/raubot.ts";

type Env = EdgeEnv & { RAUBOT: DurableObjectNamespace<Raubot>; VERSION?: WorkerVersionMetadata; PUBLIC_URL?: string; HEALTH_WEBHOOK_URL?: string; HEALTH_WEBHOOK_TOKEN?: string };

const within = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

/** Cron health check: probes the box (restarting a dead daemon) and raubot's Durable Object, and posts problems to the Devin health automation. */
const watch = async (env: Env) => {
	const box = env.BOX.getByName("main");
	const problems = await within(box.probe(), 120_000, "box probe").catch((e) => [`box probe failed: ${String(e)}`]);
	const raubot = env.RAUBOT.get(env.RAUBOT.idFromName("main")) as unknown as { ping(): Promise<number> };
	await within(raubot.ping(), 20_000, "raubot ping").catch((e) => problems.push(`raubot's Durable Object didn't answer a ping: ${String(e)}`));
	console.log("health", JSON.stringify({ ok: !problems.length, problems }));
	if (!(await box.alertDue(problems.join("\n"))) || !env.HEALTH_WEBHOOK_URL) return;
	const body = { service: env.PUBLIC_URL ?? "https://raubot.example.com", build: buildOf(env.VERSION), at: new Date().toISOString(), problems, status: await (box.status() as Promise<unknown>).catch((e) => String(e)) };
	const r = await fetch(env.HEALTH_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json", ...(env.HEALTH_WEBHOOK_TOKEN ? { authorization: `Bearer ${env.HEALTH_WEBHOOK_TOKEN}` } : {}) }, body: JSON.stringify(body) });
	console.log("health alert", JSON.stringify({ status: r.status }));
};

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		// Default deny: every route needs a verified Cloudflare Access JWT, except the few public ones in access.ts.
		const denied = await gate(req, env);
		if (denied) return denied;
		// The edge always runs the latest deploy; raubot's Durable Object keeps old code until it restarts, so it is told what's deployed.
		const core = (r: Request) => {
			const tagged = new Request(r);
			tagged.headers.set(BUILD_HEADER, buildOf(env.VERSION));
			return env.RAUBOT.get(env.RAUBOT.idFromName("main")).fetch(tagged);
		};
		return (await edge(req, env, core)) ?? core(req);
	},
	scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(watch(env));
	},
} satisfies ExportedHandler<Env>;
