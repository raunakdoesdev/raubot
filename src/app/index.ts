// The web app: a client of the core. It serves the pages and turns HTTP/WebSocket calls into `Core` calls.
import type { Core } from "../core/api.ts";
import type { Computer } from "../core/box.ts";
import settings from "./settings.html";
import tree from "./tree.html";
import ui from "./ui.html";

const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });

/** Routes that need no core: the chat page and the box status. */
export const edge = async (req: Request, box: DurableObjectNamespace<Computer>) => {
	const { pathname } = new URL(req.url);
	if (pathname === "/") return html(ui);
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
	out(core.snapshot());
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
	switch (url.pathname) {
		case "/ws": return socket(core);
		case "/settings": return html(settings);
		case "/settings.json": return Response.json(await core.settings());
		case "/tree": return html(tree);
		case "/tree.json": return Response.json(core.tree(url.searchParams));
		case "/prompt": return new Response(core.prompt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
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
