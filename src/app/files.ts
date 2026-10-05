// Workspace file viewer API: read-only browsing of an allowlist of box folders, for the web UI.
// Checks run inside the box (realpath, so symlinks can't escape); secrets, keys, .ssh and .git are never served.
import type { EdgeEnv } from "./index.ts";

/** Runs in the box with the request as JSON on stdin. */
const PY = "import json, os, sys, base64, re, stat, mimetypes\nROOTS = [\"/workspace/research\", \"/workspace/briefings\", \"/workspace/uploads\", \"/scratch\", \"/workspace/exe\", \"/workspace/repos\", \"/workspace/scan\", \"/workspace/scan2\", \"/workspace/raubot\"]\nDENY_DIRS = {\".ssh\", \".git\", \".gnupg\", \".aws\", \".docker\", \".config\", \".raubot\", \".wrangler\", \".cache\", \".bitwarden\", \"Bitwarden CLI\"}\nDENY_NAME = re.compile(r\"(^\\.env($|\\.)|^\\.dev\\.vars|^\\.npmrc$|^\\.netrc$|^\\.git-credentials$|^\\.pgpass$|^id_(rsa|dsa|ecdsa|ed25519)|\\.(pem|key|p12|pfx|kdbx|keystore|jks)$|^authorized_keys$|^known_hosts$|^cf-svc|^cf-env|^vault|(^|[._-])(tokens?|secrets?|credentials?|passwords?|passwd|apikey|api[._-]key)([._-]|$))\", re.I)\nFULL = 20 * 2**20\ndef bad(name): return name in DENY_DIRS or bool(DENY_NAME.search(name))\ndef roots(): return [(r, os.path.realpath(r)) for r in ROOTS if os.path.isdir(r)]\ndef check(p):\n    if not isinstance(p, str) or not p.startswith(\"/\") or \"\\0\" in p: raise PermissionError(\"bad path\")\n    norm = os.path.normpath(p)\n    real = os.path.realpath(norm)\n    for r, rr in roots():\n        for base, target in ((r, norm), (rr, real)):\n            if target != base and not target.startswith(base + \"/\"): break\n        else:\n            parts = [x for x in (norm[len(r):] + \"/\" + real[len(rr):]).split(\"/\") if x]\n            if any(bad(x) for x in parts): raise PermissionError(\"blocked\")\n            return norm, real\n    raise PermissionError(\"outside allowed folders\")\ndef main():\n    a = json.load(sys.stdin); op = a.get(\"op\")\n    if op == \"roots\":\n        return {\"roots\": [{\"path\": r, \"name\": r} for r, _ in roots()]}\n    p, real = check(a.get(\"path\"))\n    st = os.stat(real)\n    if op == \"list\":\n        if not stat.S_ISDIR(st.st_mode): raise NotADirectoryError(\"not a folder\")\n        out = []\n        with os.scandir(real) as it:\n            for e in it:\n                if bad(e.name): continue\n                try:\n                    _, er = check(p + \"/\" + e.name); s = os.stat(er)\n                except Exception: continue\n                out.append({\"name\": e.name, \"dir\": stat.S_ISDIR(s.st_mode), \"size\": s.st_size, \"mtime\": int(s.st_mtime)})\n        out.sort(key=lambda x: (not x[\"dir\"], x[\"name\"].lower()))\n        n = len(out)\n        return {\"path\": p, \"entries\": out[:3000], \"total\": n}\n    if op == \"read\":\n        if not stat.S_ISREG(st.st_mode): raise IsADirectoryError(\"not a file\")\n        size = st.st_size\n        off = max(0, int(a.get(\"offset\") or 0))\n        ln = a.get(\"length\")\n        if ln is None:\n            if size > FULL: return {\"error\": \"too big\", \"size\": size, \"status\": 413}\n            ln = size\n        ln = max(0, min(int(ln), FULL))\n        with open(real, \"rb\") as f:\n            f.seek(off); b = f.read(ln)\n        return {\"path\": p, \"size\": size, \"offset\": off, \"mtime\": int(st.st_mtime), \"mime\": mimetypes.guess_type(p)[0], \"b64\": base64.b64encode(b).decode()}\n    raise ValueError(\"bad op\")\ntry: r = main()\nexcept PermissionError as e: r = {\"error\": str(e), \"status\": 403}\nexcept FileNotFoundError: r = {\"error\": \"not found\", \"status\": 404}\nexcept (NotADirectoryError, IsADirectoryError, ValueError) as e: r = {\"error\": str(e), \"status\": 400}\nexcept Exception as e: r = {\"error\": type(e).__name__, \"status\": 500}\nsys.stdout.write(json.dumps(r))\n";

/** Ranged text reads are capped at RANGE; whole-file reads (download, images, PDFs) at 20 MB (enforced in PY). */
const RANGE = 2 * 2 ** 20;

/** Types the browser may render inline; everything else is served as plain text or a download. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|svg\+xml)|application\/pdf)$/;

type Out = { error?: string; status?: number; b64?: string; size?: number; offset?: number; mime?: string | null; path?: string };

const box = async (env: EdgeEnv, args: object): Promise<Out> => {
	const r = await env.BOX.getByName("main").exec('python3 -c "$FV_PY"', JSON.stringify(args), 60, { FV_PY: PY });
	try { return JSON.parse(r.out) as Out; } catch { return { error: (r.err || r.out).slice(0, 300) || "box error", status: 502 }; }
};

const fail = (o: Out) => new Response(o.error ?? "error", { status: o.status ?? 500, headers: { "cache-control": "no-store" } });

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** /file/<path> maps to a box path: /file/scratch/x -> /scratch/x, /file/workspace/x and /file/x -> /workspace/x. */
const boxPath = (rest: string) => {
	const p = rest.split("/").map((x) => { try { return decodeURIComponent(x); } catch { return x; } }).join("/");
	return /^(scratch|workspace)(\/|$)/.test(p) ? "/" + p : "/workspace/" + p;
};

const HTML = /^(text\/html|application\/xhtml\+xml)$/;
/** Subresource types a page may load from next to it (CSS, JS, fonts, media). Others go as plain text. */
const ASSET = /^(text\/(css|javascript)|application\/(javascript|json|wasm)|font\/[\w.+-]+|image\/[\w.+-]+|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/;

/** GET /file/<path>: a file served full page (HTML for phones). HTML runs in an opaque-origin sandbox: scripts yes, app cookies/API/storage no. */
const page = async (env: EdgeEnv, url: URL): Promise<Response> => {
	const rest = url.pathname.slice("/file/".length), path = boxPath(rest);
	const o = await box(env, { op: "read", path });
	if (o.error) return fail(o);
	let mime = o.mime ?? "";
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

/** GET /files.json?path= (no path: the roots), GET /file?path=&offset=&length=&dl=1, GET /file/<path>. */
export const files = async (req: Request, env: EdgeEnv, url: URL): Promise<Response> => {
	if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
	// Behind Cloudflare Access like the rest of the app; refuse if Access isn't in front (except local dev).
	if (!req.headers.get("cf-access-jwt-assertion") && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return new Response("forbidden", { status: 403 });
	if (url.pathname.startsWith("/file/")) return page(env, url);
	const q = url.searchParams, path = q.get("path") ?? "";
	if (url.pathname === "/files.json") {
		const o = await box(env, path ? { op: "list", path } : { op: "roots" });
		return o.error ? fail(o) : Response.json(o, { headers: { "cache-control": "no-store" } });
	}
	const len = q.get("length");
	const o = await box(env, { op: "read", path, offset: Number(q.get("offset") ?? 0) || 0, length: len === null ? undefined : Math.min(RANGE, Math.max(0, Number(len) || 0)) });
	if (o.error) return fail(o);
	const name = path.split("/").pop() || "file", mime = o.mime ?? "";
	const inline = INLINE.test(mime);
	const h = new Headers({
		"content-type": inline ? mime : "text/plain; charset=utf-8",
		"x-content-type-options": "nosniff",
		"cache-control": "private, no-store",
		"x-file-size": String(o.size ?? 0),
		"x-file-offset": String(o.offset ?? 0),
		"content-disposition": `${q.get("dl") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
	});
	if (q.get("dl")) h.set("content-type", "application/octet-stream");
	// PDFs need the browser's viewer; anything else rendered raw gets no scripts.
	if (mime !== "application/pdf") h.set("content-security-policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
	return new Response(bytes(o.b64 ?? ""), { headers: h });
};
