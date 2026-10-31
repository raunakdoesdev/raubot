<script lang="ts">
	import { tick } from "svelte";
	import { FileText, Folder } from "@lucide/svelte";
	import { Button } from "$lib/components/ui/button";
	import { doc, highlight, langOf } from "$lib/md";
	import { listUrl, pageUrl, raw, resolve } from "$lib/files.svelte";

	/** One file (or folder) of a box, previewed by type. `version` changes when the file changed on disk: text and images reload, media offer to. */
	let { path, box, version = "", onopen }: { path: string; box: number; version?: string; onopen: (path: string) => void } = $props();

	type Entry = { name: string; dir: boolean; size: number; mtime: number };
	type View =
		| { kind: "loading" } | { kind: "error"; msg: string }
		| { kind: "dir"; entries: Entry[]; total: number }
		| { kind: "md"; html: string; size: number; cut: boolean }
		| { kind: "text"; html: string; text: string; size: number; loaded: number; lang?: string }
		| { kind: "image" } | { kind: "pdf" } | { kind: "html" } | { kind: "video" } | { kind: "audio" } | { kind: "binary"; size: number };

	const IMG = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i, PDF = /\.pdf$/i, HTML = /\.x?html?$/i, MD = /\.(md|markdown|mdx)$/i, JSONX = /\.(json|jsonl|ndjson|geojson|har)$/i;
	const VIDEO = /\.(mp4|m4v|webm|mov|ogv)$/i, AUDIO = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;
	const BIN = /\.(zip|gz|tgz|tar|bz2|xz|7z|bin|exe|so|dylib|o|a|wasm|woff2?|ttf|otf|docx?|xlsx?|pptx?|sqlite3?|db|mkv|avi|heic|psd|pyc|class|jar|parquet|arrow|npy|pt|safetensors|onnx)$/i;
	/** Markdown/JSON render whole up to MD_MAX; text loads in CHUNK ranges. */
	const MD_MAX = 2 * 2 ** 20, CHUNK = 256 * 1024;

	let view = $state<View>({ kind: "loading" }), body: HTMLElement | undefined = $state();
	let seq = 0, shown = $state(""), stale = $state(false);
	const name = $derived(path.split("/").filter(Boolean).pop() ?? "");
	const size = (n: number) => (n < 1024 ? n + " B" : n < 2 ** 20 ? (n / 1024).toFixed(1) + " KB" : n < 2 ** 30 ? (n / 2 ** 20).toFixed(1) + " MB" : (n / 2 ** 30).toFixed(2) + " GB");
	const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
	/** Cache-buster so a changed image/PDF/page reloads. */
	const v = $derived(version ? "&v=" + encodeURIComponent(version) : "");

	async function fetchRange(p: string, offset: number, length: number) {
		const r = await fetch(raw(p, "&offset=" + offset + "&length=" + length, box));
		if (!r.ok) throw new Error(r.status === 403 ? "Hidden: this is a protected or secret file." : r.status === 404 ? "Not found." : await r.text());
		return { bytes: new Uint8Array(await r.arrayBuffer()), size: Number(r.headers.get("x-file-size") ?? 0) };
	}
	const looksBinary = (b: Uint8Array) => b.subarray(0, 4096).includes(0);

	async function load(p: string, quiet = false) {
		const my = ++seq;
		if (!quiet) view = { kind: "loading" };
		stale = false;
		try {
			if (IMG.test(p)) return void (view = { kind: "image" });
			if (PDF.test(p)) return void (view = { kind: "pdf" });
			if (HTML.test(p)) return void (view = { kind: "html" });
			if (VIDEO.test(p)) return void (view = { kind: "video" });
			if (AUDIO.test(p)) return void (view = { kind: "audio" });
			if (p.endsWith("/") || !/\.[^/]+$/.test(p)) {
				const r = await fetch(listUrl("path=" + encodeURIComponent(p.replace(/(.)\/+$/, "$1")), box));
				if (my !== seq) return;
				if (r.ok) { const d = await r.json(); return void (view = { kind: "dir", entries: d.entries, total: d.total }); }
				if (r.status !== 400) throw new Error(r.status === 403 ? "Hidden: this folder is protected." : r.status === 404 ? (await r.text()) || "Not found." : await r.text());
			}
			const md = MD.test(p), js = JSONX.test(p);
			const { bytes, size: sz } = await fetchRange(p, 0, md || js ? MD_MAX : CHUNK);
			if (my !== seq) return;
			if (BIN.test(p) || looksBinary(bytes)) return void (view = { kind: "binary", size: sz });
			let text = new TextDecoder().decode(bytes);
			if (md) {
				view = { kind: "md", html: doc(text), size: sz, cut: bytes.length < sz };
				await tick(); fixLinks(p);
			} else {
				let lang = langOf(p);
				if (js && bytes.length === sz && /\.(json|geojson|har)$/i.test(p)) { try { text = JSON.stringify(JSON.parse(text), null, 2); lang = "json"; } catch {} }
				view = { kind: "text", text, html: highlight(text, lang), size: sz, loaded: bytes.length, lang };
			}
		} catch (e) { if (my === seq) view = { kind: "error", msg: e instanceof Error ? e.message : String(e) }; }
	}

	async function more() {
		if (view.kind !== "text") return;
		const cur = view, { bytes } = await fetchRange(path, cur.loaded, CHUNK);
		const text = cur.text + new TextDecoder().decode(bytes);
		view = { ...cur, text, html: highlight(text, cur.lang), loaded: cur.loaded + bytes.length };
	}

	/** Relative links open in the panel; relative images load from the box; external links open in a new tab. */
	function fixLinks(p: string) {
		if (!body) return;
		for (const img of body.querySelectorAll("img")) {
			const src = img.getAttribute("src") ?? "";
			if (!/^(https?:|data:)/i.test(src)) img.src = raw(resolve(p, decodeURI(src)), "", box);
			img.loading = "lazy";
		}
		for (const a of body.querySelectorAll("a[href]")) {
			const href = a.getAttribute("href")!;
			if (a.hasAttribute("data-file") || href.startsWith("#")) continue;
			if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); continue; }
			const target = resolve(p, decodeURI(href.split("#")[0]));
			a.setAttribute("data-file", target); a.setAttribute("data-file-box", String(box)); a.setAttribute("href", "#file=" + encodeURIComponent(target));
		}
	}

	// New path: full load. Same path, new version: quiet reload for text/dirs (keeps scroll), images/pages via the cache-buster, media get a "reload" chip so playback isn't cut.
	$effect(() => {
		const key = box + ":" + path;
		if (key !== shown) { shown = key; void load(path); return; }
		void version;
		if (view.kind === "video" || view.kind === "audio") stale = true;
		else if (view.kind === "text" || view.kind === "md" || view.kind === "dir" || view.kind === "binary") void load(path, true);
	});
	let media = $state(0);
</script>

<div bind:this={body} class="relative h-full overflow-y-auto overscroll-contain">
	{#if stale}<div class="sticky top-0 z-10 flex justify-center p-2"><Button size="sm" variant="secondary" class="rounded-full shadow" onclick={() => { stale = false; media++; }}>File changed · reload</Button></div>{/if}
	{#if view.kind === "loading"}<div class="p-6 text-sm text-muted-foreground">loading…</div>
	{:else if view.kind === "error"}<div class="p-6 text-sm text-destructive">{view.msg}</div>
	{:else if view.kind === "md"}
		<article class="doc mx-auto max-w-3xl px-6 py-8">{@html view.html}</article>
		{#if view.cut}<div class="px-6 pb-8 text-sm text-muted-foreground">Showing the first {size(MD_MAX)} of {size(view.size)}. Download for the rest.</div>{/if}
	{:else if view.kind === "text"}
		<pre class="min-h-full p-4 font-mono text-xs leading-relaxed"><code class="hljs !bg-transparent !p-0">{@html view.html}</code></pre>
		{#if view.loaded < view.size}<div class="px-4 pb-6"><Button variant="secondary" size="sm" onclick={more}>Load more ({size(view.loaded)} of {size(view.size)})</Button></div>{/if}
	{:else if view.kind === "image"}<div class="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(#8881_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-4"><img src={raw(path, v, box)} alt={name} class="max-h-full max-w-full rounded" /></div>
	{:else if view.kind === "video"}{#key media}<div class="flex min-h-full items-center justify-center bg-black p-2"><!-- svelte-ignore a11y_media_has_caption --><video src={raw(path, "&v=" + media + v, box)} controls playsinline preload="metadata" class="max-h-full max-w-full"></video></div>{/key}
	{:else if view.kind === "audio"}{#key media}<div class="flex min-h-full items-center justify-center p-6"><audio src={raw(path, "&v=" + media + v, box)} controls preload="metadata" class="w-full"></audio></div>{/key}
	{:else if view.kind === "pdf"}<iframe src={raw(path, v, box)} title={name} class="h-full w-full border-0 bg-white"></iframe>
	{:else if view.kind === "html"}
		<!-- No allow-same-origin: the page gets an opaque origin, so its JS can't reach the app's cookies, storage or API. -->
		<iframe src={pageUrl(path, box) + (version ? "?v=" + encodeURIComponent(version) : "")} title={name} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads" referrerpolicy="no-referrer" class="h-full w-full border-0 bg-white"></iframe>
	{:else if view.kind === "binary"}<div class="p-6 text-sm text-muted-foreground">Binary file · {size(view.size)}. Use download.</div>
	{:else if view.kind === "dir"}
		<ul class="p-2 text-sm">
			{#each view.entries as e (e.name)}
				<li><button class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-accent" onclick={() => onopen(path.replace(/\/+$/, "") + "/" + e.name + (e.dir ? "/" : ""))}>
					{#if e.dir}<Folder class="size-4 shrink-0 text-muted-foreground" />{:else}<FileText class="size-4 shrink-0 text-muted-foreground" />{/if}
					<span class="truncate">{e.name}</span>
					<span class="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{e.dir ? "" : size(e.size) + " · "}{when(e.mtime)}</span>
				</button></li>
			{:else}<li class="px-3 py-2 text-muted-foreground">empty</li>{/each}
			{#if view.total > view.entries.length}<li class="px-3 py-2 text-xs text-muted-foreground">{view.total - view.entries.length} more not shown</li>{/if}
		</ul>
	{/if}
</div>
