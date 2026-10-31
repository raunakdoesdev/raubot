import type { Api, Model } from "@earendil-works/pi-ai";

/** Writer agents: Meta's Muse Wonder on OpenRouter (not in pi-ai's catalog yet: see withMuseWonder). */
export const MUSE = { provider: "openrouter", modelId: "meta/muse-wonder" };

/** The OpenRouter provider plus meta/muse-wonder, cloned from its sibling meta/muse-spark-1.3 (same chat api) with Wonder's context and price. */
export const withMuseWonder = <P extends { getModels(): readonly Model<Api>[]; getAllModels?(): readonly unknown[] }>(p: P): P => {
	const base = p.getModels().find((m) => m.id === "meta/muse-spark-1.3");
	if (!base || p.getModels().some((m) => m.id === MUSE.modelId)) return p;
	const wonder = { ...base, id: MUSE.modelId, name: "Meta: Muse Wonder", contextWindow: 1_048_576, maxTokens: 943_718, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 } } as Model<Api>;
	return Object.assign(Object.create(p), {
		getModels: () => [...p.getModels(), wonder],
		...(p.getAllModels && { getAllModels: () => [...p.getAllModels!(), wonder] }),
	}) as P;
};
