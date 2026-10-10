import * as web from "../src/core/search.ts";

const ok = (c: boolean, s: string) => { console.log((c ? "PASS " : "FAIL ") + s); if (!c) process.exitCode = 1; };

const completion = { choices: [{ message: { content: "x", annotations: [
	{ type: "url_citation", url_citation: { url: "https://a.example", title: "A", content: "first\n  snippet" } },
	{ type: "url_citation", url_citation: { url: "https://a.example", title: "A again", content: "dup" } },
	{ type: "file", url_citation: { url: "https://skip.example" } },
	{ type: "url_citation", url_citation: { url: "https://b.example", title: "B", content: "second" } },
] } }] };
const r = web.parse(completion);
ok(r.length === 2 && r[0].url === "https://a.example" && r[0].snippet === "first snippet" && r[1].title === "B", "parse: ranked, deduped, url_citation only");
ok(web.parse({ choices: [{ message: {} }] }).length === 0, "parse: no annotations -> []");

const b = web.body("q", 7) as { plugins: { id: string; max_results: number }[] };
ok(b.plugins[0].id === "web" && b.plugins[0].max_results === 7, "body uses web plugin with max_results");

let calls = 0, inflight = 0, peak = 0;
const fake = (async (_u: string, init: RequestInit) => {
	calls++; inflight++; peak = Math.max(peak, inflight);
	const q = JSON.parse(String(init.body)).messages[0].content as string;
	await new Promise((s) => setTimeout(s, 20));
	inflight--;
	if (q === "flaky" && calls < 3) return new Response("busy", { status: 429 });
	return new Response(JSON.stringify({ choices: [{ message: { annotations: [{ type: "url_citation", url_citation: { url: "https://" + q.replace(/\W/g, "") + ".example", title: q } }] } }] }));
}) as unknown as typeof fetch;
const qs = Array.from({ length: 10 }, (_, i) => "query " + i);
const all = await Promise.all(qs.map((q) => web.search("k", q, 5, fake)));
ok(all.every((x, i) => x[0].title === qs[i]) && peak === 10, "10 parallel searches, each gets its own results");

calls = 0;
const retried = await web.search("k", "flaky", 5, fake);
ok(retried.length === 1 && calls === 3, "retries 429 then succeeds");

let threw = "";
try { await web.search(undefined, "q", 5, fake); } catch (e) { threw = (e as Error).message; }
ok(/OPENROUTER_API_KEY/.test(threw), "missing key is a clear error");
