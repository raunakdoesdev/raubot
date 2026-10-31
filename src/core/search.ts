// tools.web_search for codemode scripts: the server-side web search is only a top-level tool, so scripts get this one.
// One cheap OpenRouter call with the web plugin; its url_citation annotations are the results.

export type Result = { title: string; url: string; snippet: string };
type Annotation = { type?: string; url_citation?: { url?: string; title?: string; content?: string } };
type Completion = { choices?: { message?: { content?: string; annotations?: Annotation[] } }[]; error?: { message?: string } };

export const MODEL = "openai/gpt-4.1-nano";

export const body = (query: string, max: number) => ({
	model: MODEL,
	max_tokens: 1,
	messages: [{ role: "user", content: query }],
	plugins: [{ id: "web", engine: "exa", max_results: max }],
});

/** Ranked, de-duplicated results from a completion's url_citation annotations. */
export const parse = (c: Completion): Result[] => {
	if (c.error) throw new Error(`web_search failed: ${c.error.message ?? "unknown error"}`);
	const seen = new Set<string>();
	const out: Result[] = [];
	for (const a of c.choices?.[0]?.message?.annotations ?? []) {
		const u = a.url_citation;
		if (a.type !== "url_citation" || !u?.url || seen.has(u.url)) continue;
		seen.add(u.url);
		out.push({ title: u.title ?? "", url: u.url, snippet: (u.content ?? "").replace(/\s+/g, " ").trim().slice(0, 1500) });
	}
	return out;
};

export const search = async (key: string | undefined, query: string, max = 5, f: typeof fetch = fetch): Promise<Result[]> => {
	if (!key) throw new Error("web_search: OPENROUTER_API_KEY is not set");
	if (!query?.trim()) throw new Error("web_search: query is empty");
	const n = Math.max(1, Math.min(10, Math.round(max)));
	for (let attempt = 0; ; attempt++) {
		const r = await f("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify(body(query, n)),
		});
		if ((r.status === 429 || r.status >= 500) && attempt < 2) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt)); continue; }
		const text = await r.text();
		let c: Completion;
		try { c = JSON.parse(text); } catch { throw new Error(`web_search: HTTP ${r.status}: ${text.slice(0, 300)}`); }
		if (!r.ok) throw new Error(`web_search: HTTP ${r.status}: ${c.error?.message ?? text.slice(0, 300)}`);
		return parse(c);
	}
};

export const DESCRIPTION = `Search the web from a script: ranked [{ title, url, snippet }] (max_results 1-10, default 5). Parallel-safe, e.g. batch queries:
  const rs = await Promise.all(qs.map((q) => tools.web_search({ query: q })));
Put every criterion in one query. Same as the top-level web search, but callable here. Alias: tools.openrouter_web_search.`;
