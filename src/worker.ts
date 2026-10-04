import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as C } from "@earendil-works/chord/context";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { Message } from "@earendil-works/pi-ai";
import {
	type Conversation, type ConversationView, createRegistry, defineExtension, defineTool, GenerationTask, Harness,
	hook, section,
} from "@earendil-works/pi-durable";
import type { EntryId } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { Memory, type Msg } from "./memory.ts";
import { EXECUTOR, MARKS, MASTER, SELF, VIEW_DOC } from "./prompts.ts";
import { DoSqlite } from "./sql.ts";
import type { Computer } from "./box.ts";
export { Computer } from "./box.ts";
import { type App, codemode, describe, type Nested } from "./codemode.ts";
import { Mcp } from "./mcp.ts";
import { OAuth } from "./oauth.ts";
import settings from "./settings.html";
import tree from "./tree.html";
import ui from "./ui.html";

type Env = { RAUBOT: DurableObjectNamespace<Raubot>; BOX: DurableObjectNamespace<Computer>; ARTIFACTS: Artifacts; OPENAI_API_KEY: string; ANTHROPIC_API_KEY?: string; OPENROUTER_API_KEY?: string; PROVIDER: string; EXECUTOR_URL: string; MODEL: string; COMPACT_MODEL: string; SPECTRUM_WEBHOOK_SECRET: string; AI: Ai };

const text = (c: unknown) =>
	typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";

/** Cut the view at the last line end before each mark; every piece but the tail ends on a cache breakpoint. */
export const pieces = (view: string) => {
	const out: string[] = [];
	let at = 0;
	for (const mark of MARKS) {
		if (mark >= view.length) break;
		const cut = view.lastIndexOf("\n", mark) + 1;
		if (cut > at) out.push(view.slice(at, (at = cut)));
	}
	return { out: [...out, view.slice(at)], marks: out.length };
};

type Block = { cache_control?: unknown };
type AnthropicPayload = { system?: Block[] | string; tools?: Block[]; messages?: { role: string; content: Block[] | string }[] };

/** Anthropic allows 4 breakpoints: the view's marks plus pi's request-end mark. System and tools sit inside the first view mark's prefix. */
const markView = (marks: number) => (payload: unknown) => {
	const p = payload as AnthropicPayload;
	const first = p.messages?.find((m) => m.role === "user");
	if (!marks || !first || typeof first.content === "string") return undefined;
	for (const b of [...(Array.isArray(p.system) ? p.system : []), ...(p.tools ?? [])]) delete b.cache_control;
	for (const b of first.content.slice(0, marks)) b.cache_control = { type: "ephemeral" };
	return p;
};

export class Raubot extends DurableObject<Env> {
	memory!: Memory;
	oauth!: OAuth;
	harness!: Harness;
	root!: Conversation;
	state!: AttachedReplicatedState<ConversationView>;
	sockets = new Set<WebSocket>();
	#lock: Promise<unknown> = Promise.resolve();
	#partial = "";
	#texting = false;
	#marks = 0;
	#prompt = "";

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(() => this.#init());
	}

	/** Executor: its `skills` and `resume` as plain tools, and every app tool mounted on `tools` (one `execute` per call). Schemas cached so the prompt stays byte-stable. */
	async #executor(): Promise<{ nested: Nested[]; app?: App }> {
		if (!(await this.oauth.connected())) return { nested: [] };
		const mcp = new Mcp(this.env.EXECUTOR_URL, (force) => this.oauth.token(force));
		let list = await this.ctx.storage.get<Awaited<ReturnType<Mcp["tools"]>>>("executor-tools");
		if (!list) {
			try { list = await mcp.tools(); await this.ctx.storage.put("executor-tools", list); }
			catch (e) { console.error("executor", e); return { nested: [] }; }
		}
		const nested = list.filter((t) => t.name !== "execute").map((t) => ({
			name: t.name, description: (t.description ?? t.name).replace(/paused execute program/g, "paused app call").replace(/namespaces used by execute/g, "namespaces on `tools`"), inputSchema: t.inputSchema,
			execute: (args: Record<string, unknown>) => mcp.call(t.name, args),
		}));
		const ref = (path: string[]) => path.map((k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join("");
		const app: App = async (path, args) => {
			const out = await mcp.call("execute", { code: `return await tools${ref(path)}(${JSON.stringify(args ?? {})});` });
			const r = JSON.parse(out);
			if (r.status !== "completed") return out; // paused for approval: the agent shows it and resumes
			const v = r.execution?.value;
			if (!r.execution?.ok || v?.isError) throw new Error(JSON.stringify(r.execution?.error ?? v));
			const res = v?.structuredContent?.result ?? v?.structuredContent ?? v?.content?.map((c: { text?: string }) => c.text).join("\n") ?? v;
			return typeof res === "string" ? res : JSON.stringify(res);
		};
		return { nested, app };
	}

	async #init() {
		this.oauth = new OAuth(this.ctx.storage, this.env.EXECUTOR_URL);
		const models = createModels({ authContext: { env: async (n) => (this.env as unknown as Record<string, string>)[n], fileExists: async () => false } });
		models.setProvider(openaiProvider());
		models.setProvider(anthropicProvider());
		models.setProvider(openrouterProvider());
		const stream = models.streamSimple.bind(models);
		models.streamSimple = (model, context, options) =>
			stream(model, context, model.api === "anthropic-messages" ? { ...options, onPayload: markView(this.#marks) } : options);
		const compactor = models.getModel("openrouter", this.env.COMPACT_MODEL)!;
		this.memory = new Memory(this.ctx.storage.sql, async (systemPrompt, prompt) => {
			const r = await models.completeSimple(compactor, { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { reasoning: "low" });
			if (r.stopReason === "error" || r.stopReason === "aborted") throw new Error(r.errorMessage ?? r.stopReason);
			return text(r.content);
		}, () => this.#changed());

		const memory = this.memory;
		const executor = await this.#executor();
		const nested: Nested[] = [
			{
				name: "bash",
				description: "Run a bash command in your Linux box (cwd /workspace). Output is combined stdout+stderr with the exit code. Default timeout 120s, max 900s.",
				inputSchema: Type.Object({ cmd: Type.String(), timeout: Type.Optional(Type.Integer()) }),
				execute: ({ cmd, timeout }: { cmd: string; timeout?: number }) => this.env.BOX.getByName("main").bash(cmd, Math.min(timeout ?? 120, 900)),
			},
			{
				name: "zoom",
				description: "Look closer at messages id..id+n-1: n>1 gives the two half summaries, n=1 the full original message.",
				inputSchema: Type.Object({ id: Type.Integer(), n: Type.Integer() }),
				execute: async ({ id, n }: { id: number; n: number }) => memory.zoom(id, n),
			},
			{
				name: "date",
				description: "When message id was logged.",
				inputSchema: Type.Object({ id: Type.Integer() }),
				execute: async ({ id }: { id: number }) => memory.date(id),
			},
			{
				name: "decide",
				description: `Decision API: a very cheap, fast model (Cloudflare Clef) that reads a state and answers typed questions with probabilities, no prose. Use it to triage, filter or score lots of data (messages, records, logs, pages) instead of reading it all yourself: call it once per item, in parallel.
state: text or JSON (up to ~64k tokens). questions: map of id to
  { type: "noul", instructions } -> { noul: P(yes) }
  { type: "choice", instructions, criteria: { option: description | null, ... } } -> { choice, probabilities, confidence }
  { type: "score", instructions, criteria: [lowest level, ..., highest] } -> { score, probabilities, confidence }
model: "clef-flash" (default, 9B, fastest) or "clef" (27B, more accurate). Returns { answers } keyed by question id.
Example: find the Slack messages that need the user's attention.
  // msgs: an array you fetched, e.g. Slack messages from an Executor app
  const r = await Promise.all(msgs.map((m) => tools.decide({ state: m, questions: { act: { type: "noul", instructions: "Does this need the user to reply or act?" } } })));
  return msgs.filter((m, i) => r[i].answers.act.noul > 0.7);`,
				inputSchema: Type.Object({ state: Type.Unknown(), questions: Type.Record(Type.String(), Type.Unknown()), model: Type.Optional(Type.String()) }),
				execute: async ({ state, questions, model = "clef-flash" }: { state: unknown; questions: Record<string, unknown>; model?: string }) =>
					JSON.stringify(await this.env.AI.run(`@cf/cloudflare/${model}` as keyof AiModels, { model, state, questions } as never)),
			},
			...executor.nested,
		];
		const system = `${MASTER}\n\n${VIEW_DOC}\n\n${SELF}${executor.app ? `\n\n${EXECUTOR}` : ""}`;
		this.#prompt = `# System prompt\n\n${system}\n\n# codemode tool description\n\n${describe(nested)}\n`;
		const registry = createRegistry();
		registry.install(defineExtension({
			name: "raubot",
			sections: [section("raubot", () => system, { tag: false })],
			tools: [defineTool({
				name: "codemode", replay: "unsafe", description: describe(nested),
				parameters: Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) }),
				execute: async ({ code }, _api, ctx) => {
					const store = (await this.ctx.storage.get<Record<string, unknown>>("codemode-store")) ?? {};
					const r = await codemode(code, nested, store, (ctx as { signal?: AbortSignal }).signal, executor.app);
					if (!r.error) await this.ctx.storage.put("codemode-store", store);
					return { content: [{ type: "text", text: r.text }], isError: r.error };
				},
			})],
			hooks: [hook(GenerationTask, {
				// Each run starts from a reset, so the request is [first user message, ...this run]; prefix it with the view pinned at run start.
				beforeRequest: ({ messages }) => {
					const at = messages.findIndex((m) => m.role === "user");
					if (at < 0) return undefined;
					const first = messages[at] as Extract<Message, { role: "user" }>;
					const body = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
					const { out, marks } = pieces(`<view>\n${memory.get("pinned") ?? ""}\n</view>\n\nNew message:\n`);
					this.#marks = marks;
					return { messages: messages.with(at, { ...first, content: [...out.map((text) => ({ type: "text" as const, text })), ...body] }) };
				},
			})],
		}));

		const storage = await SqliteStorage.open(new DoSqlite(this.ctx.storage));
		this.harness = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false } } }, C);
		this.root = await this.harness.root(C, {
			agent: { model: { provider: this.env.PROVIDER, modelId: this.env.MODEL }, thinkingLevel: "medium" },
		});
		this.state = await this.root.viewState(C);
		this.state.subscribe(async (view) => {
			const msg = (view.docs["pi.live"] as { generation?: { message?: { content?: unknown } } } | undefined)?.generation?.message;
			const partial = msg ? text(msg.content) : "";
			if (partial !== this.#partial) this.#broadcast({ partial: (this.#partial = partial) });
			await this.#sync();
			void this.#textBack().catch((e) => console.error("imessage", e));
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
					if (m.role === "assistant" && m.usage) this.#usage({ date, ...m.usage });
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

	#usage(u: { date: number; input: number; output: number; cacheRead: number; cacheWrite: number }) {
		console.log("usage", JSON.stringify(u));
		const all = JSON.parse(this.memory.get("usage") ?? "[]") as object[];
		const { date, input, output, cacheRead, cacheWrite } = u;
		this.memory.set("usage", JSON.stringify([...all, { date, input, output, cacheRead, cacheWrite }].slice(-50)));
	}

	#tree(q: URLSearchParams) {
		const m = this.memory;
		const part = (l: number, i: number) => ({ l, i, id: i << l, n: 1 << l, text: m.node(l, i) ?? null });
		if (q.has("l")) {
			const l = Number(q.get("l")), i = Number(q.get("i"));
			if (l === 0) { const x = m.log[i]!; return { raw: x.text, kind: x.kind, date: new Date(x.date).toISOString() }; }
			return { children: [part(l - 1, 2 * i), part(l - 1, 2 * i + 1)] };
		}
		const rendered = m.render();
		return {
			log: m.log.length, pending: m.pending(), bytes: new TextEncoder().encode(rendered).length,
			view: m.view.map(([l, i]) => part(l, i)), usage: JSON.parse(m.get("usage") ?? "[]"),
		};
	}

	/** Spectrum webhook HMAC: hex SHA-256 of `v0:{timestamp}:{body}`, at most 5 minutes old. */
	async #signed(h: Headers, body: string) {
		const ts = h.get("x-spectrum-timestamp") ?? "", sig = h.get("x-spectrum-signature") ?? "";
		if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.env.SPECTRUM_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`)));
		return sig === `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
	}

	/** An inbound iMessage joins the same conversation; once the turn ends, its final reply is texted back from the box. */
	async #imessage(space: string, text: string) {
		await this.ctx.storage.put("imsg-reply", { space, start: this.memory.log.length });
		this.send(`[iMessage] ${text}`).catch((e) => console.error("imessage", e));
	}

	async #textBack() {
		const r = await this.ctx.storage.get<{ space: string; start: number }>("imsg-reply");
		const reply = r && !this.busy() && this.memory.log.slice(r.start).filter((m) => m.kind === "talk").at(-1)?.text;
		if (!reply || this.#texting) return;
		this.#texting = true;
		try {
			await this.ctx.storage.delete("imsg-reply");
			const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(reply)));
			const out = await this.env.BOX.getByName("main").bash(`# imessage reply\ngit -C raubot fetch -q && git -C raubot checkout -q origin/main -- imessage && cd raubot/imessage && { [ -d node_modules ] || npm i -s; } && SPACE='${r.space.replace(/'/g, "")}' TEXT_B64=${b64} node send.mjs`, 120);
			console.log("imessage reply", out);
		} finally { this.#texting = false; }
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
		if (url.pathname === "/imessage" && req.method === "POST") {
			const body = await req.text();
			if (!(await this.#signed(req.headers, body))) return new Response("bad signature", { status: 401 });
			const { message: m } = JSON.parse(body) as { message: { id: string; space: { id: string }; content: { type: string; text?: string } } };
			if (m.content.type === "text" && m.content.text && !(await this.ctx.storage.get(`imsg:${m.id}`))) {
				await this.ctx.storage.put(`imsg:${m.id}`, 1);
				await this.#imessage(m.space.id, m.content.text);
			}
			return new Response("ok");
		}
		if (url.pathname === "/reset" && req.method === "POST") {
			const keep = await this.ctx.storage.get(["oauth-client", "oauth-tokens", "executor-tools"]);
			await this.env.BOX.getByName("main").reset();
			await this.ctx.storage.deleteAlarm();
			await this.ctx.storage.deleteAll();
			await this.ctx.storage.put(Object.fromEntries(keep));
			setTimeout(() => this.ctx.abort("history cleared"), 100);
			return new Response("cleared");
		}
		if (url.pathname === "/settings") return new Response(settings, { headers: { "content-type": "text/html; charset=utf-8" } });
		if (url.pathname === "/settings.json") {
			const tools = await this.ctx.storage.get<unknown[]>("executor-tools");
			return Response.json({ executor: await this.oauth.connected(), tools: tools?.length ?? 0 });
		}
		if (url.pathname === "/oauth/start") return Response.redirect(await this.oauth.start(/^(localhost|127\.0\.0\.1)$/.test(url.hostname) ? url.origin : `https://${url.host}`), 302);
		if (url.pathname === "/oauth/callback") {
			try { await this.oauth.callback(url.searchParams); }
			catch (e) { return new Response(`Executor connection failed: ${e instanceof Error ? e.message : e}`, { status: 400 }); }
			await this.ctx.storage.delete("executor-tools");
			// Restart so the Executor tools get registered on the next init.
			setTimeout(() => this.ctx.abort("executor connected"), 100);
			return Response.redirect(`${url.origin}/`, 302);
		}
		if (url.pathname === "/prompt") return new Response(this.#prompt, { headers: { "content-type": "text/plain; charset=utf-8" } });
		if (url.pathname === "/tree") return new Response(tree, { headers: { "content-type": "text/html; charset=utf-8" } });
		if (url.pathname === "/tree.json") return Response.json(this.#tree(url.searchParams));
		return new Response("not found", { status: 404 });
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(req.url);
		if (pathname === "/box") {
			const box = env.BOX.getByName("main");
			return Response.json(req.method === "POST" ? await box.stop() : await box.status());
		}
		if (pathname === "/") return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8" } });
		return env.RAUBOT.get(env.RAUBOT.idFromName("main")).fetch(req);
	},
} satisfies ExportedHandler<Env>;
