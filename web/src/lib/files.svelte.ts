/** The file panel's state: which box path is open (null = closed). Opened by clicking a path anywhere, or #file=<path>. */
export const viewer = $state<{ path: string | null }>({ path: null });

export const openFile = (path: string) => {
	viewer.path = path;
	const h = "#file=" + encodeURIComponent(path);
	if (location.hash !== h) history.replaceState(null, "", h);
};
export const closeFile = () => {
	viewer.path = null;
	if (location.hash.startsWith("#file=")) history.replaceState(null, "", location.pathname + location.search);
};

const fromHash = () => { const m = /^#file=(.+)$/.exec(location.hash); if (m) viewer.path = decodeURIComponent(m[1]); };
fromHash();
addEventListener("hashchange", fromHash);
// One delegated listener: any element with data-file (chat, transcripts, documents) opens the panel.
document.addEventListener("click", (e) => {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
	const t = e.target as Element | null;
	const a = t?.closest?.("[data-file]");
	if (a) { e.preventDefault(); openFile(a.getAttribute("data-file")!); return; }
	// Plain links (chat, transcripts, trace rows): same-origin /file/<path> opens the panel; other origins open a new tab.
	const l = t?.closest?.("a[href]") as HTMLAnchorElement | null;
	if (!l || l.hasAttribute("download") || (l.target && l.target !== "_self")) return;
	let u: URL;
	try { u = new URL(l.href); } catch { return; }
	if (u.origin === location.origin) {
		if (!u.pathname.startsWith("/file/")) return;
		const rel = u.pathname.slice(6).split("/").map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join("/");
		e.preventDefault();
		openFile(rel.startsWith("scratch/") ? "/" + rel : "/workspace/" + rel);
		return;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return;
	e.preventDefault();
	window.open(u.href, "_blank", "noopener,noreferrer");
});

/** Resolves a relative link in a document against its folder. */
export const resolve = (base: string, rel: string) => {
	const parts = (rel.startsWith("/") ? rel : base.replace(/\/[^/]*$/, "/") + rel).split("/");
	const out: string[] = [];
	for (const p of parts) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); }
	return "/" + out.join("/");
};
export const raw = (path: string, extra = "") => `/file?path=${encodeURIComponent(path)}${extra}`;
/** Full-page URL for a box path: /workspace/x -> /file/x, /scratch/x -> /file/scratch/x. */
export const pageUrl = (path: string) => "/file/" + path.replace(/^\/workspace\//, "").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
