import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createModels } from "@earendil-works/pi-ai/models";
import { agent, agents, buildOf, refuse, SCRIPT_MAX_MS, seen, STALL_MS, watchdog, type AgentHost, type Info, type Progress } from "../src/core/agents.ts";
import { Storage } from "../src/core/fx.ts";
import { MASTER, SUBAGENT, WRITER } from "../src/core/prompts.ts";
import { MUSE, withMuseWonder } from "../src/core/muse.ts";

// refuse: writers are leaves like computer agents, and any depth may start one.
assert.equal(refuse(undefined, false, true), undefined, "raubot may start a writer");
assert.equal(refuse({ id: 2, task: "", started: 0, depth: 2 }, false, true), undefined, "a depth-2 subagent may start a writer");
assert.match(refuse({ id: 3, task: "", started: 0, writer: true }, false, true)!, /writer agent can't/);
assert.match(refuse({ id: 3, task: "", started: 0, writer: true }, true)!, /writer agent can't/);
assert.match(refuse(undefined, true, true)!, /not both/);
assert.match(refuse({ id: 2, task: "", started: 0, depth: 2 }, false)!, /nest at most/);

// A fake host and in-memory storage.
const store = new Map<string, unknown>();
const storage = {
	get: async (k: string) => store.get(k),
	put: async (e: Record<string, unknown>) => { for (const [k, v] of Object.entries(e)) store.set(k, v); },
	delete: async (ks: string[]) => { for (const k of ks) store.delete(k); return ks.length; },
	list: async ({ prefix }: { prefix: string }) => new Map([...store].filter(([k]) => k.startsWith(prefix))),
};
const created: { computer: boolean; writer?: boolean; box?: string }[] = [];
const builds = { running: "aaaa1111", deployed: "aaaa1111" };
const asked: string[] = [];
const host: AgentHost = {
	create: async (computer, writer, box) => { created.push({ computer, writer, ...(box && { box }) }); return 40 + created.length; },
	ask: async (_id, content) => { asked.push(content); return "Shipped X today."; },
	needless: async () => false, running: async () => false, last: async () => "Shipped X today.", steer: async () => {}, stop: async () => {},
	builds: () => builds,
	progress: async (id) => progress.get(id) ?? { running: false, at: 0, tools: 0 },
	notify: async (info, text) => { notices.push({ id: info.id, parent: info.parent, text }); },
};
const progress = new Map<number, Progress>();
const notices: { id: number; parent?: number; text: string }[] = [];
const run = <A>(e: Effect.Effect<A, unknown, Storage>) => Effect.runPromise(e.pipe(Effect.provide(Layer.succeed(Storage, storage as never))));

const reply = await run(agent(host, "agent:t:1", { task: "Write a Slack post about X", writer: true }));
assert.equal(reply, "Shipped X today.");
assert.deepEqual(created[0], { computer: false, writer: true }, "host told to make a writer");
assert.equal((store.get("agentinfo:41") as Info).writer, true, "writer stored in AgentInfo");
assert.ok(asked[0].includes(WRITER) && !asked[0].includes(SUBAGENT), "writer gets its own brief, not the VIEW-based one");
assert.match(WRITER, /plain-writing\.md/);

await run(agent(host, "agent:t:2", { task: "plain task" }));
assert.deepEqual(created[1], { computer: false, writer: false });
assert.equal((store.get("agentinfo:42") as Info).writer, undefined, "plain subagents carry no writer flag");
assert.ok(asked[1].includes(SUBAGENT));

const list = await run(agents(host, {})) as { id: number; writer: boolean }[];
assert.equal(list.find((a) => a.id === 41)?.writer, true, "tools.agents shows writer");
assert.equal(list.find((a) => a.id === 42)?.writer, false);

// vm: own by default (a new box agent-<id>); shared runs in the caller's box, and a shared agent's own shared child lands in that same box.
assert.equal((store.get("agentinfo:42") as Info).box, "agent-42", "own box by default");
assert.equal((store.get("agentinfo:42") as Info).vm, "own");
await run(agent(host, "agent:t:3", { task: "edit my uncommitted files", vm: "shared" }, { depth: 1, box: "main" }));
assert.deepEqual(created[2], { computer: false, writer: false, box: "main" }, "host told to reuse raubot's box");
assert.deepEqual([(store.get("agentinfo:43") as Info).vm, (store.get("agentinfo:43") as Info).box], ["shared", "main"]);
await run(agent(host, "agent:t:4", { task: "nested", vm: "shared" }, { depth: 2, parent: 44, box: "agent-44" }));
assert.equal((store.get("agentinfo:44") as Info).box, "agent-44", "shared under a subagent: the subagent's box");
await run(agent(host, "agent:t:5", { task: "nested own", vm: "own" }, { depth: 2, parent: 44, box: "agent-44" }));
assert.equal(created[4].box, undefined, "own never reuses the caller's box");
const listed = await run(agents(host, {})) as { id: number; vm: string; box: string }[];
assert.deepEqual([listed.find((a) => a.id === 43)?.vm, listed.find((a) => a.id === 43)?.box], ["shared", "main"], "tools.agents shows where a shared agent runs");
assert.deepEqual([listed.find((a) => a.id === 42)?.vm, listed.find((a) => a.id === 42)?.box], ["own", "agent-42"]);

// build: each row shows the raubot build that started it; stale appears only when raubot runs an older build than the deployed one.
const fresh = await run(agents(host, {})) as { id: number; build: string; stale?: string }[];
assert.equal(fresh.find((a) => a.id === 41)?.build, "aaaa1111", "tools.agents shows the build that started each agent");
assert.ok(fresh.every((a) => a.stale === undefined), "no stale flag when running the deployed build");
builds.deployed = "bbbb2222";
await run(agent(host, "agent:t:6", { task: "after deploy" }));
const lagging = await run(agents(host, {})) as { id: number; build: string; stale?: string }[];
assert.equal(lagging.find((a) => a.id === 46)?.build, "aaaa1111", "a stale instance stamps its own old build");
assert.match(lagging[0].stale!, /runs build aaaa1111 but bbbb2222 is deployed/, "tools.agents flags a deployed-but-not-live instance");
store.set("agentinfo:7", { id: 7, task: "old record", started: 1 });
assert.equal((await run(agents(host, {})) as { id: number; build: string }[]).find((a) => a.id === 7)?.build, "?", "records from before builds were tracked");
assert.equal(buildOf({ id: "962c6c07-1234-5678-9abc-def012345678" }), "962c6c07");
assert.equal(buildOf(undefined), "dev");

// The system prompt rule.
assert.match(MASTER, /tools\.agent\(\{ writer: true \}\)/);

// Muse Wonder is registered on OpenRouter as a clone of muse-spark-1.3.
const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
assert.equal(models.getModel("openrouter", MUSE.modelId), undefined, "absent from the stock catalog");
models.setProvider(withMuseWonder(openrouterProvider()));
const m = models.getModel("openrouter", MUSE.modelId)!;
const spark = models.getModel("openrouter", "meta/muse-spark-1.3")!;
assert.ok(m, "muse-wonder registered");
assert.equal(m.api, spark.api);
assert.equal(m.baseUrl, spark.baseUrl);
assert.equal(m.contextWindow, 1_048_576);
assert.ok(models.getModel("openrouter", "anthropic/claude-opus-5.5"), "rest of the catalog intact");
console.log("agents ok");

// Stall watchdog: one notice per stall, to the parent, quiet while healthy, retrying, or already reported.
{
	const now = Date.now();
	for (const k of [...store.keys()]) if (k.startsWith("agentinfo:") || k.startsWith("stall:")) store.delete(k);
	store.set("agentinfo:100", { id: 100, task: "sign into Apple", started: now - 3600_000, computer: true, parent: 7 } satisfies Info);
	store.set("agentinfo:101", { id: 101, task: "healthy", started: now - 3600_000 } satisfies Info);
	store.set("agentinfo:102", { id: 102, task: "retrying", started: now - 3600_000 } satisfies Info);
	store.set("agentinfo:103", { id: 103, task: "long ago", started: now - 5 * 86400_000 } satisfies Info);
	store.set("agentinfo:104", { id: 104, task: "old error", started: now - 86400_000 } satisfies Info);
	progress.set(100, { running: true, at: now - STALL_MS - 60_000, tools: 0 });
	progress.set(101, { running: true, at: now - 60_000, tools: 1 });
	progress.set(102, { running: true, at: now - STALL_MS * 2, error: "504 origin_gateway_timeout", retryAt: now + 30_000, tools: 0 });
	progress.set(103, { running: true, at: 0, tools: 0 });
	progress.set(104, { running: false, at: now - 5 * 3600_000, error: "504", tools: 0 });

	const live = await run(watchdog(host, now));
	assert.equal(live, 3, "counts running recent subagents so the alarm keeps watching");
	assert.deepEqual(notices.map((n) => n.id), [100], "only the agent with no step for 10 min is reported");
	assert.equal(notices[0].parent, 7, "notice carries the parent so the host can steer it");
	assert.match(notices[0].text, /^\[agent 100 stalled\] no new step in 11 min/);
	assert.match(notices[0].text, /Last output: Shipped X today\./, "notice includes the last output");

	await run(watchdog(host, now + 60_000));
	assert.equal(notices.length, 1, "the same stall is reported once, even as minutes grow");

	progress.set(100, { running: true, at: now + 120_000, tools: 0 });
	progress.set(102, { running: true, at: now - STALL_MS * 2, error: "504 origin_gateway_timeout", tools: 0 });
	await run(watchdog(host, now + 180_000));
	assert.deepEqual(notices.map((n) => n.id), [100, 102], "a failed call with no retry queued is a stall; progress clears the old one");
	assert.match(notices[1].text, /model call failed and no retry is queued/);

	store.set("agentinfo:105", { id: 105, task: "asked", started: now } satisfies Info);
	progress.set(105, { running: false, at: now, error: "504", tools: 0 });
	await run(seen(host, 105, now));
	await run(watchdog(host, now + 1000));
	assert.ok(!notices.some((n) => n.id === 105), "an error its ask already returned to a job isn't reported again");

	store.set("agentinfo:106", { id: 106, task: "steered then died", started: now } satisfies Info);
	progress.set(106, { running: false, at: now, error: "504", tools: 0 });
	await run(watchdog(host, now + 1000));
	assert.ok(notices.some((n) => n.id === 106 && /stopped on a model error/.test(n.text)), "a fresh unreported error on an idle agent is reported");

	const listed = await run(agents(host, {})) as { id: number; lastProgress?: string; stalled?: string }[];
	assert.equal(listed.find((a) => a.id === 101)?.lastProgress, new Date(now - 60_000).toISOString(), "tools.agents exposes lastProgress");
	assert.equal(listed.find((a) => a.id === 101)?.stalled, undefined);
	assert.match(listed.find((a) => a.id === 102)?.stalled ?? "", /no retry is queued/, "tools.agents says why one looks stuck");
}
console.log("agents watchdog ok");

// Live failure 2026-10-22 (agent 116264): one bash "sleep 690" inside codemode was cut at the 600 s script cap, so the call never stayed in flight past STALL_MS. A hung tool call must outlive the threshold and get exactly one notice while it hangs.
{
	const BASH_MAX_MS = 900_000;
	assert.ok(SCRIPT_MAX_MS >= BASH_MAX_MS, "a codemode script lets a nested bash call use its full 900 s");
	assert.ok(SCRIPT_MAX_MS > STALL_MS + 60_000, "a hung call lives past the stall threshold plus one watchdog pass");

	const start = Date.now();
	store.set("agentinfo:200", { id: 200, task: "sleep 15 min in bash", started: start, parent: 9 } satisfies Info);
	progress.set(200, { running: true, at: start, tools: 1 });
	const before = notices.length;
	for (let t = start; t < start + SCRIPT_MAX_MS; t += 60_000) await run(watchdog(host, t));
	const mine = notices.slice(before).filter((n) => n.id === 200);
	assert.equal(mine.length, 1, "one notice per hung tool call, not one per minute");
	assert.match(mine[0].text, /^\[agent 200 stalled\] no new step in 1[01] min \(a tool call is still in flight/);
	assert.equal(mine[0].parent, 9);
}
console.log("agents hung tool call ok");
