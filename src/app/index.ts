// The web app: a client of the core. It serves the pages and turns HTTP/WebSocket calls into `Core` calls.
import type { Core } from "../core/api.ts";
import type { Computer } from "../core/box.ts";
import settings from "./settings.html";
import tree from "./tree.html";
import ui from "./ui.html";
import og from "./og.png";
import secret from "./secret.html";

/** Expiry choices for a secret, in seconds; 0 keeps it. */
export const TTLS = [["Keep until removed", 0], ["1 hour", 3600], ["1 day", 86_400], ["7 days", 604_800], ["30 days", 2_592_000]] as const;
const ttlOptions = TTLS.map(([l, s]) => `<option value="${s}">${l}</option>`).join("");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const FORM = `<input name="value" type="password" placeholder="Paste the secret" autocomplete="off" autofocus required><div class="row"><select name="ttl">${ttlOptions}</select><button>Save</button></div><div class="note">Encrypted at rest. raubot can use it but never sees it.</div>`;

const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });

/** Routes that need no core: the chat page and the box status. */
export const edge = async (req: Request, box: DurableObjectNamespace<Computer>) => {
	const { pathname } = new URL(req.url);
	if (pathname === "/") return html(ui.replace("<!--TTLS-->", ttlOptions));
	if (pathname === "/s/og.png") return new Response(og, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
	if (pathname === "/box") {
		const b = box.getByName("main");
		return Response.json(req.method === "POST" ? await b.stop() : await b.status());
	}
	return undefined;
};

const socket = (core: Core) => {
	const [client, server] = Object.values(new WebSocketPair());
	server.accept();
	const out = (m: object) => { try { server.send(JSON.stringify(m)); } catch { off(); } };
	void core.snapshot().then(out);
	const off = core.subscribe(out);
	server.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data)) as { send?: string; files?: string[]; stop?: true };
		if (m.send || m.files?.length) core.send(m.send ?? "", undefined, m.files).catch((e) => out({ error: String(e) }));
		if (m.stop) void core.stop();
	});
	server.addEventListener("close", off);
	return new Response(null, { status: 101, webSocket: client });
};

/** Routes served inside the core's Durable Object. */
export const serve = async (core: Core, req: Request): Promise<Response> => {
	const url = new URL(req.url);
	// Secret form links: outside Cloudflare Access (so iMessage can preview them); the token is the only key.
	const token = /^\/s\/([\w-]{32})$/.exec(url.pathname)?.[1];
	if (token) {
		if (req.method === "POST") {
			const { value, ttl } = (await req.json()) as { value?: string; ttl?: number };
			try { await core.answer(token, String(value ?? ""), TTLS.some(([, s]) => s === ttl) ? ttl : undefined); }
			catch (e) { return new Response(e instanceof Error ? e.message : String(e), { status: 400 }); }
			return new Response("saved");
		}
		const a = await core.ask(token);
		const fill = (name: string, why: string, body: string) => html(secret.replace(/\{\{(\w+)\}\}/g, (_, k) => ({ name: esc(name), why: esc(why), origin: url.origin, body })[k as "name"] ?? ""));
		return a ? fill(a.name, a.why, FORM) : fill("nothing", "This link has expired or was already used.", "");
	}
	switch (url.pathname) {
		case "/ws": return socket(core);
		case "/settings": return html(settings);
		case "/settings.json": return Response.json(await core.settings());
		case "/tree": return html(tree);
		case "/tree.json": return Response.json(core.tree(url.searchParams));
		case "/prompt": return new Response(core.prompt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
		case "/secrets.json":
			if (req.method === "DELETE") await core.removeSecret(url.searchParams.get("name") ?? "");
			return Response.json(await core.secrets());
		case "/upload": {
			if (req.method !== "POST") break;
			const f = (await req.formData()).get("file");
			if (!(f instanceof File)) return new Response("no file", { status: 400 });
			return Response.json({ path: await core.upload(f.name, new Uint8Array(await f.arrayBuffer())) });
		}
		case "/reset":
			if (req.method !== "POST") break;
			await core.reset();
			return new Response("cleared");
		case "/oauth/start":
			return Response.redirect(await core.oauthStart(/^(localhost|127\.0\.0\.1)$/.test(url.hostname) ? url.origin : `https://${url.host}`), 302);
		case "/oauth/callback":
			try { await core.oauthDone(url.searchParams); }
			catch (e) { return new Response(`Executor connection failed: ${e instanceof Error ? e.message : e}`, { status: 400 }); }
			return Response.redirect(`${url.origin}/`, 302);
	}
	return new Response("not found", { status: 404 });
};
