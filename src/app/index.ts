// The web app: a client of the core. It serves the pages and turns HTTP/WebSocket calls into `Core` calls.
import type { Core } from "../core/api.ts";
import type { Computer } from "../core/box.ts";
import og from "./og.png";
import { TTLS } from "./ttl.ts";
import { files } from "./files.ts";
import { oidc, type OidcEnv } from "./oidc.ts";
import { type AccessEnv, identity } from "./access.ts";

const TOKEN = /^\/s\/([\w-]{32})(\.json)?$/;
/** Secret-link pages never pass their URL (the token) on as a Referer, and aren't cached. */
const noReferrer = (r: Response) => { const o = new Response(r.body, r); o.headers.set("referrer-policy", "no-referrer"); o.headers.set("cache-control", "no-store"); return o; };

export type EdgeEnv = { BOX: DurableObjectNamespace<Computer>; ASSETS: Fetcher; BOX_BACKEND?: string } & OidcEnv & AccessEnv;

/** Routes that need no core: the built pages (web/), the box status, and a secret link's page with its preview tags. */
export const edge = async (req: Request, env: EdgeEnv, core: (r: Request) => Promise<Response>) => {
	const url = new URL(req.url), { pathname } = url;
	const asset = (p: string) => env.ASSETS.fetch(new URL(p, url));
	if (pathname === "/" || pathname === "/settings" || pathname === "/tree" || pathname === "/voice" || pathname.startsWith("/assets/") || pathname === "/favicon.png" || pathname === "/raubot-512.png" || pathname === "/raubot-mascot.png" || pathname === "/apple-touch-icon.png") return asset(pathname);
	// Secret links skip Access, so their page loads its assets relative to /s/.
	if (pathname.startsWith("/s/assets/") || pathname === "/s/favicon.png" || pathname === "/s/apple-touch-icon.png") return asset(pathname.slice(2));
	if (pathname.startsWith("/s/oidc/")) return oidc(req, env);
	if (pathname === "/s/og.png") return new Response(og, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
	// Access-gated (the Worker gate already checked): signs in, then back to a secret link so its form can save.
	if (pathname === "/login") {
		const next = url.searchParams.get("next") ?? "/";
		return Response.redirect(new URL(TOKEN.test(next) || next === "/" ? next : "/", url).toString(), 302);
	}
	const token = TOKEN.exec(pathname);
	// The ask behind a link (public, read-only) plus whether this browser is signed in to Access, so the form knows if it can save.
	if (token && token[2] && req.method === "GET") {
		const r = await core(req);
		if (!r.ok) return r;
		return Response.json({ ...((await r.json()) as object), signedIn: !!(await identity(req, env)) }, { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
	}
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
			.transform(noReferrer(await asset("/secret")));
	}
	if (pathname === "/files.json" || pathname === "/file" || pathname.startsWith("/file/")) return files(req, env, url);
	const screen = /^\/agent\/(\d+)\/screen\.jpg$/.exec(pathname);
	if (screen) {
		// On Boat a computer agent works in raubot's box (see Raubot.#boxOf).
		const s = (await env.BOX.getByName(`agent-${screen[1]}`).screen()) ?? (env.BOX_BACKEND === "boat" ? await env.BOX.getByName("main").screen() : undefined);
		return s ? new Response(s.jpeg, { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-url": s.url } }) : new Response(null, { status: 204 });
	}
	// Take control: a new Boat desktop URL per request, only to this app's own page (same-origin fetch metadata), never logged or stored.
	const take = /^\/takeover\/(main|agent-\d+)(\/release)?$/.exec(pathname);
	if (take) {
		if (req.headers.get("sec-fetch-site") !== "same-origin") return new Response("open this from the raubot app", { status: 403 });
		const box = env.BOX.getByName(take[1]), main = env.BOX.getByName("main");
		// On Boat a computer agent works in raubot's box (see Raubot.#boxOf), so its desktop is main's.
		const viaMain = take[1] !== "main" && env.BOX_BACKEND === "boat";
		if (take[2]) {
			if (req.method !== "POST") return new Response("POST only", { status: 405 });
			await Promise.all([box.release(), viaMain ? main.release() : undefined]);
			return new Response("released");
		}
		const t0 = Date.now();
		const url = (await box.desktop()) ?? (viaMain ? await main.desktop() : undefined);
		console.log("takeover", JSON.stringify({ box: take[1], ms: Date.now() - t0, ok: !!url }));
		if (!url) return new Response("This box isn't on Boat, so there's no desktop to take over.", { status: 404 });
		return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store", "referrer-policy": "no-referrer", "server-timing": `mint;dur=${Date.now() - t0}` } });
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
	// Hold live events until the snapshot is out, so a new line can't arrive first and look like a gap.
	let early: object[] | undefined = [];
	const off = core.subscribe((m) => (early ? early.push(m) : out(m)));
	void core.snapshot().then((s) => { out(s); for (const m of early!) out(m); early = undefined; });
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
	// Devin callbacks: outside Access like secret links; each run's HMAC secret is the key.
	const hook = /^\/s\/devin\/([\w-]{6,64})(\/image)?$/.exec(url.pathname);
	if (hook) return req.method !== "POST" ? new Response("POST only", { status: 405 }) : hook[2] ? core.devinImage(hook[1], req) : core.devinHook(hook[1], req);
	// Secret form links: outside Cloudflare Access (so iMessage can preview them); the token is the only key.
	const [, token, json] = TOKEN.exec(url.pathname) ?? [];
	if (token) {
		if (json) {
			const a = await core.ask(token);
			return a ? Response.json({ name: a.name, why: a.why }) : new Response("expired", { status: 404 });
		}
		if (req.method === "DELETE") { await core.dismiss(token); return new Response("dismissed"); }
		// Writes reach here only with a verified Access JWT (worker gate): a leaked link alone can't set or drop a secret.
		if (req.method === "POST") {
			const { value, ttl } = ((await req.json().catch(() => ({}))) ?? {}) as { value?: string; ttl?: number };
			try { await core.answer(token, String(value ?? ""), TTLS.some(([, s]) => s === ttl) ? ttl : undefined); }
			catch (e) { return new Response(e instanceof Error ? e.message : String(e), { status: 400 }); }
			return new Response("saved");
		}
	}
	switch (url.pathname) {
		case "/ws": return socket(core);
		case "/settings.json": return Response.json(await core.settings());
		// Voice: POST only (no CSRF-able GETs with side effects); all behind Access like the rest.
		case "/voice/session":
			if (req.method !== "POST") break;
			try { return Response.json(await core.voiceSession(), { headers: { "cache-control": "no-store" } }); }
			catch (e) { return new Response(e instanceof Error ? e.message : String(e), { status: 502 }); }
		case "/voice/ask": {
			if (req.method !== "POST") break;
			const { message } = ((await req.json().catch(() => ({}))) ?? {}) as { message?: string };
			if (!message?.trim()) return new Response("empty message", { status: 400 });
			return Response.json(await core.voiceAsk(message));
		}
		case "/voice/wait": {
			if (req.method !== "POST") break;
			const { id } = ((await req.json().catch(() => ({}))) ?? {}) as { id?: string };
			return Response.json(await core.voiceWait(String(id ?? "")));
		}
		case "/voice/status": return Response.json(await core.voiceStatus());
		case "/tree.json": return Response.json(core.tree(url.searchParams));
		case "/prompt": return new Response(core.prompt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
		case "/secrets.json":
			if (req.method === "DELETE") await core.removeSecret(url.searchParams.get("name") ?? "");
			return Response.json(await core.secrets());
		case "/agents.json":
			try { return Response.json(await core.agentList()); }
			catch (e) { console.error("agents.json", e); return Response.json({ error: String(e).slice(0, 200) }, { status: 500 }); }
		case "/agent.json": {
			const id = Number(url.searchParams.get("id"));
			if (req.method === "POST") {
				const { message } = (await req.json()) as { message?: string };
				if (!message?.trim()) return new Response("empty message", { status: 400 });
				try { return Response.json({ ok: await core.agentSend(id, message.trim()) }); }
				catch (e) { return new Response(e instanceof Error ? e.message : String(e), { status: 400 }); }
			}
			const t = await core.agentTranscript(id);
			return t ? Response.json(t) : new Response("no such subagent", { status: 404 });
		}
		case "/upload": {
			if (req.method !== "POST") break;
			const f = (await req.formData()).get("file");
			if (!(f instanceof File)) return new Response("no file", { status: 400 });
			return Response.json({ path: await core.upload(f.name, new Uint8Array(await f.arrayBuffer())) });
		}
		case "/traces.json": {
			const conv = url.searchParams.get("conv");
			return Response.json(await core.traceRuns(conv ? Number(conv) : undefined));
		}
		case "/trace.json": {
			const run = url.searchParams.get("run") ?? "", call = url.searchParams.get("call");
			const t = call === null ? await core.trace(run) : await core.traceBody(run, Number(call));
			return t ? Response.json(t) : new Response("no such trace", { status: 404 });
		}
		case "/reset":
			if (req.method !== "POST") break;
			await core.reset();
			return new Response("cleared");
		case "/agents/all.json": return Response.json(await core.agentIndex());
		case "/oauth/start":
			return Response.redirect(await core.oauthStart(/^(localhost|127\.0\.0\.1)$/.test(url.hostname) ? url.origin : `https://${url.host}`), 302);
		case "/oauth/callback":
			try { await core.oauthDone(url.searchParams); }
			catch (e) { return new Response(`Executor connection failed: ${e instanceof Error ? e.message : e}`, { status: 400 }); }
			return Response.redirect(`${url.origin}/`, 302);
	}
	return new Response("not found", { status: 404 });
};
