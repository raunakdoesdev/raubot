// Box file browser API: read-only browsing of a box's whole filesystem (raubot's or a subagent's), for the web UI.
// Checks run inside the box (fsview.py: realpath, so symlinks can't escape); /proc, /sys, /dev, keys, tokens, env files and vault data are never served.
// Works through the box abstraction (Computer.exec/status), so it follows the box to any backend.
import type { EdgeEnv } from "./index.ts";
import PY from "./fsview.py";
import { boxName, byteRange, pagePath, SLICE } from "./fsparse.ts";

/** An agent box name ("main" | "agent-<id>") to the box it really runs in. */
export type BoxOf = (name: string) => Promise<string>;

/** Ranged text reads are capped at RANGE; whole-file reads (download, images, PDFs) at 20 MB (enforced in PY). */
const RANGE = 2 * 2 ** 20;

/** Types the browser may render inline; everything else is served as plain text or a download. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)|application\/pdf|video\/[\w.+-]+|audio\/[\w.+-]+)$/;
const MEDIA = /^(video|audio)\//;
const EXTRA_MIME: Record<string, string> = { webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", m4a: "audio/mp4", opus: "audio/ogg", flac: "audio/flac", avif: "image/avif", webp: "image/webp", heic: "image/heic", md: "text/markdown", ts: "text/plain", svelte: "text/plain" };

type Out = { error?: string; status?: number; b64?: string; size?: number; offset?: number; mime?: string | null; path?: string; [k: string]: unknown };

/** Boxes known to exist (ran at least once), so browsing never creates a box for a subagent that never used one. */
const known = new Set<string>(["main"]);

const run = async (env: EdgeEnv, name: string, args: object): Promise<Out> => {
	const b = env.BOX.getByName(name);
	if (!known.has(name)) {
		const s = (await b.status()) as { running?: boolean; snapshot?: unknown; last?: unknown };
		if (!s.running && !s.snapshot && !s.last) return { error: "This agent never used its box, so there are no files to show.", status: 404 };
		known.add(name);
	}
	const r = await b.exec('python3 -c "$FV_PY"', JSON.stringify(args), 90, { FV_PY: PY });
	try { return JSON.parse(r.out) as Out; } catch { return { error: (r.err || r.out).slice(0, 300) || "box error", status: 502 }; }
};

const fail = (o: Out) => new Response(o.error ?? "error", { status: o.status ?? 500, headers: { "cache-control": "no-store" } });
const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const mimeOf = (path: string, m?: string | null) => m || EXTRA_MIME[path.split(".").pop()!.toLowerCase()] || "";

const HTML = /^(text\/html|application\/xhtml\+xml)$/;
/** Subresource types a page may load from next to it (CSS, JS, fonts, media). Others go as plain text. */
const ASSET = /^(text\/(css|javascript)|application\/(javascript|json|wasm)|font\/[\w.+-]+|image\/[\w.+-]+|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/;

/** GET /file/<path> (or /file/~<agent>/<path>): a file served full page (HTML for phones). HTML runs in an opaque-origin sandbox: scripts yes, app cookies/API/storage no. */
const page = async (env: EdgeEnv, url: URL, boxOf: BoxOf): Promise<Response> => {
	const p = pagePath(url.pathname.slice("/file/".length)), path = p.path, box = await boxOf(p.box);
	const o = await run(env, box, { op: "read", path });
	if (o.error) return fail(o);
	let mime = mimeOf(path, o.mime);
	if (/\.m?js$/i.test(path)) mime = "text/javascript";
	const html = HTML.test(mime) || /\.x?html?$/i.test(path);
	const h = new Headers({ "x-content-type-options": "nosniff", "cache-control": "private, no-store", "referrer-policy": "no-referrer", "cross-origin-opener-policy": "same-origin" });
	if (html) {
		// Relative assets: only this file's folder on this site. No connect-src: no fetch/XHR/WebSocket to the app API.
		const dir = url.origin + url.pathname.replace(/[^/]*$/, "");
		h.set("content-type", "text/html; charset=utf-8");
		h.set("content-security-policy", [
			"sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads",
			"default-src 'none'",
			"script-src 'unsafe-inline' 'unsafe-eval' " + dir + " blob:",
			"style-src 'unsafe-inline' " + dir,
			"img-src data: blob: " + dir,
			"font-src data: " + dir,
			"media-src data: blob: " + dir,
			"frame-src data: blob: " + dir,
			"connect-src 'none'", "form-action 'none'", "base-uri 'none'",
			"frame-ancestors " + url.origin,
		].join("; "));
	} else {
		h.set("content-type", ASSET.test(mime) ? (mime.startsWith("text/") ? mime + "; charset=utf-8" : mime) : "text/plain; charset=utf-8");
		if (mime !== "application/pdf") h.set("content-security-policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
	}
	return new Response(bytes(o.b64 ?? ""), { headers: h });
};

/**
 * GET /files.json?box=&path= (no path: the roots), ?box=&paths=a,b (several listings, for live polling), ?box=&find=q&path=root, ?box=&stat=path.
 * GET /file?box=&path=&offset=&length=&dl=1 (Range: bytes= streams video/audio and big files in SLICE pieces), GET /file/<path>.
 */
export const files = async (req: Request, env: EdgeEnv, url: URL, boxOf: BoxOf): Promise<Response> => {
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
	// Access: the Worker's default-deny gate (access.ts) has verified the JWT before this runs.
	if (url.pathname.startsWith("/file/")) return page(env, url, boxOf);
	const q = url.searchParams, path = q.get("path") ?? "";
	const asked = boxName(q.get("box"));
	if (!asked) return new Response("bad box", { status: 400 });
	const box = await boxOf(asked);
	const json = (o: Out) => (o.error ? fail(o) : Response.json(o, { headers: { "cache-control": "no-store" } }));
	if (url.pathname === "/files.json") {
		if (q.has("paths")) return json(await run(env, box, { op: "lists", paths: q.getAll("paths").flatMap((p) => p.split("\n")).filter(Boolean) }));
		if (q.has("find")) return json(await run(env, box, { op: "find", q: q.get("find"), path: path || "/workspace" }));
		if (q.has("stat")) return json(await run(env, box, { op: "stat", path: q.get("stat") }));
		return json(await run(env, box, path ? { op: "list", path } : { op: "roots" }));
	}
	const name = path.split("/").pop() || "file";
	const len = q.get("length"), rangeH = req.headers.get("range");
	let args: { op: string; path: string; offset: number; length?: number };
	let ranged = false;
	if (rangeH) {
		// Size first (cheap stat), then the slice: Content-Range needs both.
		const s = await run(env, box, { op: "stat", path });
		if (s.error) return fail(s);
		const r = byteRange(rangeH, Number(s.size ?? 0));
		if (r === "bad") return new Response(null, { status: 416, headers: { "content-range": `bytes */${s.size}` } });
		if (r) { args = { op: "read", path, offset: r.start, length: r.end - r.start + 1 }; ranged = true; }
		else args = { op: "read", path, offset: 0 };
	} else if (len !== null) args = { op: "read", path, offset: Number(q.get("offset") ?? 0) || 0, length: Math.min(RANGE, Math.max(0, Number(len) || 0)) };
	else args = { op: "read", path, offset: 0 };
	let o = await run(env, box, args);
	// Too big to send whole: media and downloads stream from the first slice (the browser asks for the rest by Range).
	if (o.status === 413 && !ranged) { o = await run(env, box, { op: "read", path, offset: 0, length: SLICE }); ranged = true; }
	if (o.error) return fail(o);
	const mime = mimeOf(path, o.mime), body = bytes(o.b64 ?? ""), size = Number(o.size ?? 0), off = Number(o.offset ?? 0);
	const inline = INLINE.test(mime);
	const h = new Headers({
		"content-type": inline ? mime : "text/plain; charset=utf-8",
		"x-content-type-options": "nosniff",
		"cache-control": "private, no-store",
		"accept-ranges": "bytes",
		"x-file-size": String(size),
		"x-file-offset": String(off),
		"x-file-mtime": String(o.mtime ?? ""),
		"content-disposition": `${q.get("dl") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
	});
	if (q.get("dl")) h.set("content-type", "application/octet-stream");
	// PDFs need the browser's viewer and media its player; anything else rendered raw gets no scripts.
	if (mime !== "application/pdf" && !MEDIA.test(mime)) h.set("content-security-policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
	if (ranged) {
		h.set("content-range", `bytes ${off}-${off + body.length - 1}/${size}`);
		return new Response(req.method === "HEAD" ? null : body, { status: 206, headers: h });
	}
	return new Response(req.method === "HEAD" ? null : body, { headers: h });
};
