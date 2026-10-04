/** Minimal MCP client over streamable HTTP: initialize, tools/list, tools/call. */
type Tool = { name: string; description?: string; inputSchema: Record<string, unknown> };
type Content = { type: string; text?: string };

export class Mcp {
	#session?: string;
	#id = 0;
	#ready?: Promise<void>;

	constructor(readonly url: string, readonly token: string) {}

	async #rpc(method: string, params?: unknown, notify = false): Promise<any> {
		const headers: Record<string, string> = {
			"content-type": "application/json", accept: "application/json, text/event-stream",
			authorization: `Bearer ${this.token}`, "mcp-protocol-version": "2025-06-18",
		};
		if (this.#session) headers["mcp-session-id"] = this.#session;
		const id = notify ? undefined : ++this.#id;
		const r = await fetch(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method, params, id }) });
		this.#session = r.headers.get("mcp-session-id") ?? this.#session;
		if (r.status === 404 && this.#session && method !== "initialize") {
			this.#session = this.#ready = undefined;
			await this.#init();
			return this.#rpc(method, params, notify);
		}
		if (!r.ok) throw new Error(`MCP ${method}: HTTP ${r.status} ${(await r.text()).slice(0, 500)}`);
		if (notify) return;
		const body = await r.text();
		const msgs = (r.headers.get("content-type") ?? "").includes("text/event-stream")
			? body.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))
			: [JSON.parse(body)];
		const msg = msgs.find((m) => m.id === id);
		if (!msg) throw new Error(`MCP ${method}: no response`);
		if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message}`);
		return msg.result;
	}

	#init() {
		return (this.#ready ??= (async () => {
			await this.#rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raubot", version: "1" } });
			await this.#rpc("notifications/initialized", undefined, true);
		})().catch((e) => { this.#ready = undefined; throw e; }));
	}

	async tools(): Promise<Tool[]> {
		await this.#init();
		return (await this.#rpc("tools/list", {})).tools;
	}

	async call(name: string, args: unknown): Promise<string> {
		await this.#init();
		const r = await this.#rpc("tools/call", { name, arguments: args });
		const out = (r.content as Content[]).map((c) => c.text ?? JSON.stringify(c)).join("\n");
		return r.isError ? `error: ${out}` : out;
	}
}
