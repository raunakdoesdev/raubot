import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as C } from "@earendil-works/chord/context";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { Message } from "@earendil-works/pi-ai";
import {
	type Conversation, type ConversationView, createRegistry, defineExtension, defineTool, GenerationTask, Harness,
	hook, section,
} from "@earendil-works/pi-durable";
import type { EntryId } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { Memory, type Msg } from "./memory.ts";
import { MASTER, VIEW_DOC } from "./prompts.ts";
import { DoSqlite } from "./sql.ts";
import ui from "./ui.html";

type Env = { RAUBOT: DurableObjectNamespace<Raubot>; OPENAI_API_KEY: string; MODEL: string; COMPACT_MODEL: string };

const text = (c: unknown) =>
	typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";

export class Raubot extends DurableObject<Env> {
	memory!: Memory;
	harness!: Harness;
	root!: Conversation;
	state!: AttachedReplicatedState<ConversationView>;
	sockets = new Set<WebSocket>();
	#lock: Promise<unknown> = Promise.resolve();
	#partial = "";

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => this.#init());
	}

	async #init() {
		const models = createModels({ authContext: { env: async (n) => (this.env as unknown as Record<string, string>)[n], fileExists: async () => false } });
		models.setProvider(openaiProvider());
		const compactor = models.getModel("openai", this.env.COMPACT_MODEL)!;
		this.memory = new Memory(this.ctx.storage.sql, async (systemPrompt, prompt) => {
			const r = await models.completeSimple(compactor, { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { reasoning: "low" });
			if (r.stopReason === "error" || r.stopReason === "aborted") throw new Error(r.errorMessage ?? r.stopReason);
			return text(r.content);
		}, () => this.#changed());

		const memory = this.memory;
		const registry = createRegistry();
		registry.install(defineExtension({
			name: "raubot",
			sections: [section("raubot", () => `${MASTER}\n\n${VIEW_DOC}`, { tag: false })],
			tools: [
				defineTool({
					name: "zoom", replay: "safe",
					description: "Look closer at messages id..id+n-1: n>1 gives the two half summaries, n=1 the full original message.",
					parameters: Type.Object({ id: Type.Integer(), n: Type.Integer() }),
					execute: async ({ id, n }) => ({ content: [{ type: "text", text: memory.zoom(id, n) }] }),
				}),
				defineTool({
					name: "date", replay: "safe",
					description: "When message id was logged.",
					parameters: Type.Object({ id: Type.Integer() }),
					execute: async ({ id }) => ({ content: [{ type: "text", text: memory.date(id) }] }),
				}),
			],
			hooks: [hook(GenerationTask, {
				// Each run starts from a reset, so the request is [first user message, ...this run]; prefix it with the view pinned at run start.
				beforeRequest: ({ messages }) => {
					const at = messages.findIndex((m) => m.role === "user");
					if (at < 0) return undefined;
					const first = messages[at] as Extract<Message, { role: "user" }>;
					const body = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
					const view = { type: "text" as const, text: `<view>\n${memory.get("pinned") ?? ""}\n</view>\n\nNew message:\n` };
					return { messages: messages.with(at, { ...first, content: [view, ...body] }) };
				},
			})],
		}));

		const storage = await SqliteStorage.open(new DoSqlite(this.ctx.storage));
		this.harness = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false } } }, C);
		this.root = await this.harness.root(C, {
			agent: { model: { provider: "openai", modelId: this.env.MODEL }, thinkingLevel: "medium" },
		});
		this.state = await this.root.viewState(C);
		this.state.subscribe(async (view) => {
			const msg = (view.docs["pi.live"] as { generation?: { message?: { content?: unknown } } } | undefined)?.generation?.message;
			const partial = msg ? text(msg.content) : "";
			if (partial !== this.#partial) this.#broadcast({ partial: (this.#partial = partial) });
			await this.#sync();
		});
		this.harness.resume();
		await this.#sync();
		this.memory.pump();
		this.#changed();
	}

	#serial<T>(op: () => Promise<T>): Promise<T> {
		const next = this.#lock.then(op, op);
		this.#lock = next.catch(() => {});
		return next;
	}

	/** Flatten new pi transcript entries into the memory log (thoughts dropped). */
	#sync() {
		return this.#serial(async () => {
			const saved = this.memory.get("entry");
			const last = saved === undefined ? undefined : Number(saved) as EntryId;
			const fresh = [];
			let cursor;
			do {
				const page = await this.root.entries(last === undefined ? {} : { minEntryId: last }, 200, cursor, C);
				fresh.push(...page.items);
				cursor = page.next;
			} while (cursor);
			for (const e of fresh.filter((e) => e.id !== last).reverse()) {
				for (const m of e.model ?? []) {
					const date = m.timestamp ?? Date.now();
					if (m.role === "user") this.#log("user", text(m.content), date);
					else if (m.role === "toolResult") this.#log("echo", `${m.toolName}: ${text(m.content)}`, date);
					else for (const b of m.content) {
						if (typeof b === "string") continue;
						if (b.type === "text") this.#log("talk", b.text, date);
						else if (b.type === "toolCall") this.#log("tool", `${b.name} ${JSON.stringify(b.arguments)}`, date);
					}
				}
				this.memory.set("entry", String(e.id));
			}
		});
	}

	#log(kind: Msg["kind"], body: string, date: number) {
		if (body.trim()) this.memory.append(kind, body, date);
	}

	busy() { return (this.state.value.docs["pi.live"] as { run?: unknown } | undefined)?.run !== undefined; }

	async send(input: string) {
		if (this.busy()) return void (await this.root.submit({ type: "input", content: input, whenBusy: "steer" }, C));
		await this.#serial(async () => {
			this.#broadcast({ status: "settling" });
			await this.memory.settle();
			this.memory.set("pinned", this.memory.render());
			await this.root.reset(undefined, C);
			await this.root.submit({ type: "input", content: input }, C);
		});
		await this.#sync();
	}

	#changed() {
		this.#broadcast({ log: this.memory.log.length, pending: this.memory.pending(), busy: this.state ? this.busy() : false });
		if (this.memory.pending()) void this.ctx.storage.setAlarm(Date.now() + 30_000);
	}

	#broadcast(m: object) {
		const s = JSON.stringify(m);
		for (const ws of this.sockets) try { ws.send(s); } catch { this.sockets.delete(ws); }
	}

	async alarm() {
		this.memory.pump();
		if (this.memory.pending()) await this.ctx.storage.setAlarm(Date.now() + 30_000);
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			const [client, server] = Object.values(new WebSocketPair());
			server.accept();
			this.sockets.add(server);
			server.send(JSON.stringify({ history: this.memory.log.slice(-200), busy: this.busy(), pending: this.memory.pending() }));
			let seen = this.memory.log.length;
			const tick = setInterval(() => {
				const fresh = this.memory.log.slice(seen);
				seen = this.memory.log.length;
				if (fresh.length) try { server.send(JSON.stringify({ history: fresh })); } catch {}
			}, 250);
			server.addEventListener("message", (ev) => {
				const m = JSON.parse(String(ev.data)) as { send?: string; stop?: true };
				if (m.send) this.send(m.send).catch((e) => server.send(JSON.stringify({ error: String(e) })));
				if (m.stop) void this.root.abort(C);
			});
			server.addEventListener("close", () => { clearInterval(tick); this.sockets.delete(server); });
			return new Response(null, { status: 101, webSocket: client });
		}
		if (url.pathname === "/tree") {
			const lines = [`# view (${this.memory.view.length} lines, ${this.memory.log.length} messages)`, this.memory.render(), ""];
			for (let l = 0; 1 << l <= this.memory.log.length; l++) {
				lines.push(`# level ${l}`);
				for (let i = 0; (i + 1) << l <= this.memory.log.length; i++) lines.push(`${i << l}+${1 << l}|${this.memory.node(l, i) ?? "-"}`);
				lines.push("");
			}
			return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
		}
		return new Response("not found", { status: 404 });
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(req.url);
		if (pathname === "/") return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8" } });
		return env.RAUBOT.get(env.RAUBOT.idFromName("main")).fetch(req);
	},
} satisfies ExportedHandler<Env>;
