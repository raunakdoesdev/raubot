import { Marked, marked } from "marked";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";

const code = ({ text, lang }: { text: string; lang?: string }) => {
	const h = lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }) : hljs.highlightAuto(text);
	return `<pre><code class="hljs">${h.value}</code></pre>`;
};

marked.setOptions({ gfm: true, breaks: true });
marked.use({ renderer: { code } });

/** Paths into the box that the file panel can open (not inside tags or existing links). */
const PATH = /(?<![\w./-])(\/(?:workspace|scratch)\/[^\s<>"'`)\]&]*[^\s<>"'`)\]&.,;:!?])/g;
export const linkPaths = (html: string) => {
	let inA = 0;
	return html.split(/(<[^>]+>)/).map((part) => {
		if (part.startsWith("<")) { if (/^<a[\s>]/i.test(part)) inA++; else if (/^<\/a>/i.test(part)) inA = Math.max(0, inA - 1); return part; }
		return inA ? part : part.replace(PATH, (p) => `<a href="#file=${encodeURIComponent(p)}" data-file="${p}" class="file-link">${p}</a>`);
	}).join("");
};

export const md = (s: string) => linkPaths(marked.parse(s ?? "", { async: false }));

/** Documents (files): no chat-style line breaks, and raw HTML is shown as text, never run. */
const docs = new Marked({ gfm: true });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
docs.use({ renderer: { code, html: ({ text }) => esc(text) } });
export const doc = (s: string) => linkPaths(docs.parse(s ?? "", { async: false }));

/** Highlighted code for a file, by extension; plain (escaped) when unknown or big. */
const EXT: Record<string, string> = { ts: "typescript", tsx: "typescript", mts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", py: "python", sh: "bash", bash: "bash", json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", css: "css", html: "xml", xml: "xml", svelte: "xml", sql: "sql", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", swift: "swift", diff: "diff", patch: "diff", dockerfile: "dockerfile", php: "php", lua: "lua", r: "r" };
export const langOf = (path: string) => { const n = path.split("/").pop()!.toLowerCase(); return EXT[n === "dockerfile" ? n : n.split(".").pop()!]; };
export const highlight = (text: string, lang?: string) => (lang && hljs.getLanguage(lang) && text.length < 300_000 ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : esc(text));
