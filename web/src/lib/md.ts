import { Marked, marked } from "marked";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";

const code = ({ text, lang }: { text: string; lang?: string }) => {
	const h = lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }) : hljs.highlightAuto(text);
	return `<pre><code class="hljs">${h.value}</code></pre>`;
};

marked.setOptions({ gfm: true, breaks: true });
/** Chat images of box files load through /file and open the file panel on click. */
const BOX = /^\/(?:workspace|scratch)\//;
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const image = ({ href, text }: { href: string; text: string }) => {
	let p = href;
	try { p = decodeURI(href); } catch {}
	if (!BOX.test(p)) return `<img src="${attr(href)}" alt="${attr(text)}" loading="lazy">`;
	return `<a href="#file=${encodeURIComponent(p)}" data-file="${attr(p)}" class="md-img"><img src="/file?path=${encodeURIComponent(p)}" alt="${attr(text)}" loading="lazy" decoding="async"></a>`;
};
marked.use({ renderer: { code, image } });

/** Paths into the box that the file panel can open (not inside tags or existing links). */
const PATH = /(?<![\w./-])(\/(?:workspace|scratch)\/[^\s<>"'`)\]&]*[^\s<>"'`)\]&.,;:!?])/g;
/** External links (http/https, other origin) open in a new tab, so the chat never navigates away. */
const EXT_A = /^<a\s(?![^>]*\btarget=)(?![^>]*\bdata-file=)[^>]*\bhref="(https?:\/\/[^"]*)"/i;
const external = (href: string) => { try { return new URL(href.replace(/&amp;/g, "&"), location.href).origin !== location.origin; } catch { return true; } };
export const linkPaths = (html: string) => {
	let inA = 0;
	return html.split(/(<[^>]+>)/).map((part) => {
		if (part.startsWith("<")) {
			const m = EXT_A.exec(part);
			if (m && external(m[1])) part = part.replace(/^<a\s/i, '<a target="_blank" rel="noopener noreferrer" ');
			if (/^<a[\s>]/i.test(part)) inA++; else if (/^<\/a>/i.test(part)) inA = Math.max(0, inA - 1); return part; }
		return inA ? part : part.replace(PATH, (p) => `<a href="#file=${encodeURIComponent(p)}" data-file="${p}" class="file-link">${p}</a>`);
	}).join("");
};

// Rows scrolling back into view re-render their text; parse each finished text once.
const cache = new Map<string, string>();
export const md = (s: string) => {
	s ??= "";
	let h = cache.get(s);
	if (h === undefined) {
		h = linkPaths(marked.parse(s, { async: false }));
		cache.set(s, h);
		if (cache.size > 500) cache.delete(cache.keys().next().value!);
	}
	return h;
};
/** Streaming text changes every frame: parsed fresh, not cached. */
export const mdLive = (s: string) => linkPaths(marked.parse(s ?? "", { async: false }));

/** Documents (files): no chat-style line breaks, and raw HTML is shown as text, never run. */
const docs = new Marked({ gfm: true });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
docs.use({ renderer: { code, html: ({ text }) => esc(text) } });
export const doc = (s: string) => linkPaths(docs.parse(s ?? "", { async: false }));

/** Highlighted code for a file, by extension; plain (escaped) when unknown or big. */
const EXT: Record<string, string> = { ts: "typescript", tsx: "typescript", mts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", py: "python", sh: "bash", bash: "bash", json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", css: "css", html: "xml", xml: "xml", svelte: "xml", sql: "sql", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", swift: "swift", diff: "diff", patch: "diff", dockerfile: "dockerfile", php: "php", lua: "lua", r: "r" };
export const langOf = (path: string) => { const n = path.split("/").pop()!.toLowerCase(); return EXT[n === "dockerfile" ? n : n.split(".").pop()!]; };
export const highlight = (text: string, lang?: string) => (lang && hljs.getLanguage(lang) && text.length < 300_000 ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : esc(text));
