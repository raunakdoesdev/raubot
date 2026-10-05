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
	const a = (e.target as Element | null)?.closest?.("[data-file]");
	if (!a) return;
	e.preventDefault();
	openFile(a.getAttribute("data-file")!);
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
