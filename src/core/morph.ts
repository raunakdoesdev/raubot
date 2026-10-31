import { envApiKeyAuth, type Api, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";

/** Morph's abliterated DeepSeek V4.1 Flash: OpenAI chat completions at api.morphllm.com, key MORPH_API_KEY. It always reasons, so pi sends no thinking params. */
export const MORPH = { provider: "morph", modelId: "morph-dsv41flash-abliterated" };

const BASE_URL = "https://api.morphllm.com/v1";

export const morphProvider = () => createProvider({
	id: MORPH.provider,
	name: "Morph",
	baseUrl: BASE_URL,
	auth: { apiKey: envApiKeyAuth("Morph API key", ["MORPH_API_KEY"]) },
	api: openAICompletionsApi(),
	models: [{
		id: MORPH.modelId, name: "Morph: DeepSeek V4.1 Flash (abliterated)", api: "openai-completions", provider: MORPH.provider, baseUrl: BASE_URL,
		reasoning: false, input: ["text"], cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 384_000,
		compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true },
	} as Model<Api>],
});
