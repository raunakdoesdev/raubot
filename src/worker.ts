import type { Computer } from "./core/box.ts";
import type { Raubot } from "./core/raubot.ts";
import { edge, type EdgeEnv } from "./app/index.ts";
export { Computer } from "./core/box.ts";
export { Raubot } from "./core/raubot.ts";

type Env = EdgeEnv & { RAUBOT: DurableObjectNamespace<Raubot> };

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const core = (r: Request) => env.RAUBOT.get(env.RAUBOT.idFromName("main")).fetch(r);
		return (await edge(req, env, core)) ?? core(req);
	},
} satisfies ExportedHandler<Env>;
