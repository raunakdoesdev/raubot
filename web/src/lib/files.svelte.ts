/** The file browser's state: which agent's box it shows (0 = raubot's own), the selected path, and whether the panel is open. #file=<path>[&box=<id>] opens it. */
export const viewer = $state<{ path: string | null; box: number; open: boolean }>({ path: null, box: 0, open: false });

const hash = () => (viewer.path ? "#file=" + encodeURIComponent(viewer.path) + (viewer.box ? "&box=" + viewer.box : "") : "#files" + (viewer.box ? "=" + viewer.box : ""));
const sync = () => { const h = hash(); if (location.hash !== h) history.replaceState(null, "", h); };

/** Open a path in a box (default: the box the panel shows). */
export const openFile = (path: string, box = viewer.box) => { viewer.path = path; viewer.box = box; viewer.open = true; sync(); };
/** Open the browser on a box without a file selected (keeps the current file when it's the same box). */
export const openBrowser = (box: number) => { if (viewer.box !== box) viewer.path = null; viewer.box = box; viewer.open = true; sync(); };
export const closeFile = () => {
	viewer.open = false;
	if (/^#(file|files)/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
};

const fromHash = () => {
	const m = /^#file=([^&]+)(?:&box=(\d+))?$/.exec(location.hash);
	if (m) { viewer.path = decodeURIComponent(m[1]); viewer.box = Number(m[2] ?? 0); viewer.open = true; return; }
	const b = /^#files(?:=(\d+))?$/.exec(location.hash);
	if (b) { viewer.box = Number(b[1] ?? 0); viewer.open = true; }
};
fromHash();
addEventListener("hashchange", fromHash);

/** The box a clicked element belongs to: the nearest [data-box] (a subagent's view), else raubot's. */
const boxOf = (el: Element) => Number(el.closest("[data-box]")?.getAttribute("data-box") ?? 0) || 0;

// One delegated listener: any element with data-file (chat, transcripts, documents) opens the panel, in the box of the view it's in.
document.addEventListener("click", (e) => {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
	const t = e.target as Element | null;
	const a = t?.closest?.("[data-file]");
	if (a) {
		e.preventDefault();
		const own = a.getAttribute("data-file-box");
		openFile(a.getAttribute("data-file")!, own !== null ? Number(own) : boxOf(a));
		return;
	}
	// Plain links (chat, transcripts, trace rows): same-origin /file/<path> opens the panel; other origins open a new tab.
	const l = t?.closest?.("a[href]") as HTMLAnchorElement | null;
	if (!l || l.hasAttribute("download") || (l.target && l.target !== "_self")) return;
	let u: URL;
	try { u = new URL(l.href); } catch { return; }
	if (u.origin === location.origin) {
		if (!u.pathname.startsWith("/file/")) return;
		let rel = u.pathname.slice(6).split("/").map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join("/");
		const m = /^~(\d+)\/(.*)$/.exec(rel);
		const box = m ? Number(m[1]) : boxOf(l);
		if (m) rel = m[2];
		e.preventDefault();
		openFile(rel.startsWith("~root/") ? rel.slice(5) : rel.startsWith("scratch/") ? "/" + rel : "/workspace/" + rel, box);
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
const boxQ = (box: number) => (box ? "&box=" + box : "");
export const raw = (path: string, extra = "", box = viewer.box) => `/file?path=${encodeURIComponent(path)}${boxQ(box)}${extra}`;
export const listUrl = (q: string, box = viewer.box) => `/files.json?${q}${boxQ(box)}`;
/** Full-page URL for a box path: /workspace/x -> /file/x, /scratch/x -> /file/scratch/x, elsewhere -> /file/~root/...; a subagent's box adds ~<id>/. */
export const pageUrl = (path: string, box = viewer.box) => {
	const rel = path.startsWith("/workspace/") ? path.slice(11) : path.startsWith("/scratch/") ? path.slice(1) : "~root" + path;
	return "/file/" + (box ? "~" + box + "/" : "") + rel.split("/").map(encodeURIComponent).join("/");
};
