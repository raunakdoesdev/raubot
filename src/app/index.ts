// The web app: a client of the core. It serves the pages and turns HTTP/WebSocket calls into `Core` calls.
import type { Core } from "../core/api.ts";
import type { Computer } from "../core/box.ts";
import og from "./og.png";
import { TTLS } from "./ttl.ts";

const TOKEN = /^\/s\/([\w-]{32})(\.json)?$/;

export type EdgeEnv = { BOX: DurableObjectNamespace<Computer>; ASSETS: Fetcher };

/** Routes that need no core: the built pages (web/), the box status, and a secret link's page with its preview tags. */
export const edge = async (req: Request, env: EdgeEnv, core: (r: Request) => Promise<Response>) => {
	const url = new URL(req.url), { pathname } = url;
	const asset = (p: string) => env.ASSETS.fetch(new URL(p, url));
	if (pathname === "/" || pathname === "/settings" || pathname === "/tree" || pathname.startsWith("/assets/")) return asset(pathname);
	// Secret links skip Access, so their page loads its assets relative to /s/.
	if (pathname.startsWith("/s/assets/")) return asset(pathname.slice(2));
	if (pathname === "/s/og.png") return new Response(og, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
	const token = TOKEN.exec(pathname);
	if (token && !token[2] && req.method === "GET") {
		const r = await core(new Request(new URL(`/s/${token[1]}.json`, url)));
		const a = r.ok ? ((await r.json()) as { name: string; why: string }) : undefined;
		const title = a ? `raubot needs ${a.name}` : "This link has expired", desc = a?.why ?? "Ask raubot for a new one.";
		const set = (v: string) => ({ element: (e: Element) => void e.setAttribute("content", v) });
		return new HTMLRewriter()
			.on("title", { element: (e) => void e.setInnerContent(title) })
			.on('meta[property="og:title"]', set(title))
			.on('meta[property="og:description"]', set(desc))
			.on('meta[property="og:image"]', set(`${url.origin}/s/og.png`))
			.transform(await asset("/secret"));
	}
	if (pathname === "/box") {
		const box = env.BOX;
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
	const [, token, json] = TOKEN.exec(url.pathname) ?? [];
	if (token) {
		if (json) {
			const a = await core.ask(token);
			return a ? Response.json({ name: a.name, why: a.why }) : new Response("expired", { status: 404 });
		}
		if (req.method === "DELETE") { await core.dismiss(token); return new Response("dismissed"); }
		if (req.method === "POST") {
			const { value, ttl } = (await req.json()) as { value?: string; ttl?: number };
			try { await core.answer(token, String(value ?? ""), TTLS.some(([, s]) => s === ttl) ? ttl : undefined); }
			catch (e) { return new Response(e instanceof Error ? e.message : String(e), { status: 400 }); }
			return new Response("saved");
		}
	}
	switch (url.pathname) {
		case "/ws": return socket(core);
		case "/settings.json": return Response.json(await core.settings());
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
