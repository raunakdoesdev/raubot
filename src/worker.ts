import type { Computer } from "./core/box.ts";
import type { Raubot } from "./core/raubot.ts";
import { edge } from "./app/index.ts";
export { Computer } from "./core/box.ts";
export { Raubot } from "./core/raubot.ts";

type Env = { RAUBOT: DurableObjectNamespace<Raubot>; BOX: DurableObjectNamespace<Computer> };

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		return (await edge(req, env.BOX)) ?? env.RAUBOT.get(env.RAUBOT.idFromName("main")).fetch(req);
	},
} satisfies ExportedHandler<Env>;
