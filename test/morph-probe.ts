// Live probe: does Morph's model make a well-formed tool call through pi-ai, and continue after the result? Run: MORPH_API_KEY=... npx tsx test/morph-probe.ts
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { MORPH, morphProvider } from "../src/core/morph.ts";

const models = createModels({ authContext: { env: async (n) => process.env[n], fileExists: async () => false } });
models.setProvider(morphProvider());
const model = models.getModel(MORPH.provider, MORPH.modelId)!;
const tools = [{ name: "codemode", description: "Run JavaScript. The input is raw JavaScript, an async function body; return a value. tools.bash({cmd}) runs a shell command.", parameters: Type.Object({ code: Type.String() }) }];
const messages: any[] = [{ role: "user", content: "Use the codemode tool to compute 17*23 with JavaScript (return it). Then tell me the number.", timestamp: Date.now() }];
for (let turn = 0; turn < 3; turn++) {
	const t0 = Date.now();
	const r = await models.completeSimple(model, { systemPrompt: "You are a helpful assistant. Use tools when asked.", tools, messages } as never, { maxTokens: 4000 } as never);
	console.log(JSON.stringify({ turn, ms: Date.now() - t0, stop: r.stopReason, err: r.errorMessage, content: r.content.map((c: any) => c.type === "toolCall" ? { toolCall: c.name, args: c.arguments } : { [c.type]: String(c.text ?? c.thinking ?? "").slice(0, 200) }) }));
	messages.push(r);
	const calls = r.content.filter((c: any) => c.type === "toolCall");
	if (!calls.length) break;
	for (const c of calls as any[]) {
		const out = String(await new Function(`return (async () => { ${c.arguments.code} })()`)());
		messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: out }], isError: false, timestamp: Date.now() });
	}
}
