import { marked } from "marked";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";

marked.setOptions({ gfm: true, breaks: true });
marked.use({ renderer: { code({ text, lang }) {
	const h = lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }) : hljs.highlightAuto(text);
	return `<pre><code class="hljs">${h.value}</code></pre>`;
} } });

export const md = (s: string) => marked.parse(s ?? "", { async: false });
