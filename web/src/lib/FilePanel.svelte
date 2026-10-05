<script lang="ts">
	import { tick } from "svelte";
	import { ChevronRight, Download, ExternalLink, FileText, Folder, X } from "@lucide/svelte";
	import { Button } from "$lib/components/ui/button";
	import { doc, highlight, langOf } from "$lib/md";
	import { closeFile, openFile, pageUrl, raw, resolve, viewer } from "$lib/files.svelte";

	type Entry = { name: string; dir: boolean; size: number; mtime: number };
	type View =
		| { kind: "loading" } | { kind: "error"; msg: string }
		| { kind: "dir"; entries: Entry[]; total: number }
		| { kind: "md"; html: string; size: number; cut: boolean }
		| { kind: "text"; html: string; text: string; size: number; loaded: number; lang?: string }
		| { kind: "image" } | { kind: "pdf" } | { kind: "html" } | { kind: "binary"; size: number };

	const IMG = /\.(png|jpe?g|gif|webp|avif|svg)$/i, PDF = /\.pdf$/i, HTML = /\.x?html?$/i, MD = /\.(md|markdown|mdx)$/i;
	const BIN = /\.(zip|gz|tgz|tar|bin|exe|so|dylib|wasm|woff2?|ttf|otf|mp[34]|mov|webm|docx?|xlsx?|pptx?|sqlite|db)$/i;
	/** Markdown renders whole up to MD_MAX; text loads in CHUNK ranges. */
	const MD_MAX = 2 * 2 ** 20, CHUNK = 256 * 1024;

	let view = $state<View>({ kind: "loading" }), body: HTMLElement | undefined = $state();
	let seq = 0;
	const path = $derived(viewer.path);
	const name = $derived(path?.split("/").filter(Boolean).pop() ?? "");
	const crumbs = $derived.by(() => {
		const parts = (path ?? "").split("/").filter(Boolean);
		return parts.map((p, i) => ({ name: p, path: "/" + parts.slice(0, i + 1).join("/") }));
	});
	const size = (n: number) => (n < 1024 ? n + " B" : n < 2 ** 20 ? (n / 1024).toFixed(1) + " KB" : (n / 2 ** 20).toFixed(1) + " MB");

	async function fetchRange(p: string, offset: number, length: number) {
		const r = await fetch(raw(p, "&offset=" + offset + "&length=" + length));
		if (!r.ok) throw new Error(r.status === 403 ? "This file isn't viewable (outside the allowed folders or blocked)." : r.status === 404 ? "Not found." : await r.text());
		return { bytes: new Uint8Array(await r.arrayBuffer()), size: Number(r.headers.get("x-file-size") ?? 0) };
	}
	const looksBinary = (b: Uint8Array) => b.subarray(0, 4096).includes(0);

	async function load(p: string) {
		const my = ++seq;
		view = { kind: "loading" };
		try {
			if (IMG.test(p)) return void (view = { kind: "image" });
			if (PDF.test(p)) return void (view = { kind: "pdf" });
			if (HTML.test(p)) return void (view = { kind: "html" });
			// Folders: try listing first when the path has no extension.
			if (!/\.[^/]+$/.test(p) || p.endsWith("/")) {
				const r = await fetch("/files.json?path=" + encodeURIComponent(p.replace(/\/+$/, "")));
				if (my !== seq) return;
				if (r.ok) { const d = await r.json(); return void (view = { kind: "dir", entries: d.entries, total: d.total }); }
				if (r.status !== 400) throw new Error(r.status === 403 ? "This folder isn't viewable." : r.status === 404 ? "Not found." : await r.text());
			}
			const md = MD.test(p);
			const { bytes, size } = await fetchRange(p, 0, md ? MD_MAX : CHUNK);
			if (my !== seq) return;
			if (BIN.test(p) || looksBinary(bytes)) return void (view = { kind: "binary", size });
			const text = new TextDecoder().decode(bytes);
			if (md) {
				view = { kind: "md", html: doc(text), size, cut: bytes.length < size };
				await tick(); fixLinks(p);
			} else {
				const lang = langOf(p);
				view = { kind: "text", text, html: highlight(text, lang), size, loaded: bytes.length, lang };
			}
		} catch (e) { if (my === seq) view = { kind: "error", msg: e instanceof Error ? e.message : String(e) }; }
	}

	async function more() {
		if (view.kind !== "text" || !path) return;
		const v = view, { bytes } = await fetchRange(path, v.loaded, CHUNK);
		const text = v.text + new TextDecoder().decode(bytes);
		view = { ...v, text, html: highlight(text, v.lang), loaded: v.loaded + bytes.length };
	}

	/** Relative links open in the panel; relative images load from the box; external links open in a new tab. */
	function fixLinks(p: string) {
		if (!body) return;
		for (const img of body.querySelectorAll("img")) {
			const src = img.getAttribute("src") ?? "";
			if (!/^(https?:|data:)/i.test(src)) img.src = raw(resolve(p, decodeURI(src)));
			img.loading = "lazy";
		}
		for (const a of body.querySelectorAll("a[href]")) {
			const href = a.getAttribute("href")!;
			if (a.hasAttribute("data-file") || href.startsWith("#")) continue;
			if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); continue; }
			const target = resolve(p, decodeURI(href.split("#")[0]));
			a.setAttribute("data-file", target); a.setAttribute("href", "#file=" + encodeURIComponent(target));
		}
	}

	$effect(() => { if (path) load(path); });
	const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && viewer.path) closeFile(); };
</script>

<svelte:window onkeydown={esc} />
{#if path}<button class="fixed inset-0 z-40 bg-black/40 lg:hidden" aria-label="close file" onclick={closeFile}></button>{/if}
<aside class="fixed inset-y-0 right-0 z-50 flex w-full max-w-[min(100vw,52rem)] flex-col border-l bg-background pt-[env(safe-area-inset-top)] shadow-2xl transition-transform duration-200 sm:w-[min(92vw,52rem)] {path ? 'translate-x-0' : 'pointer-events-none translate-x-full'}" aria-hidden={!path}>
	{#if path}
		<header class="flex h-14 shrink-0 items-center gap-1 border-b px-3">
			<FileText class="size-4 shrink-0 text-muted-foreground" />
			<nav class="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto text-sm whitespace-nowrap">
				{#each crumbs as c, i (c.path)}
					{#if i}<ChevronRight class="size-3 shrink-0 text-muted-foreground" />{/if}
					{#if i === crumbs.length - 1}<span class="px-1 font-medium">{c.name}</span>
					{:else}<button class="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground" onclick={() => openFile(c.path)}>{c.name}</button>{/if}
				{/each}
			</nav>
			{#if view.kind !== "dir"}
				<Button variant="ghost" size="icon-sm" href={view.kind === "html" ? pageUrl(path) : raw(path)} target="_blank" aria-label="open raw" title={view.kind === "html" ? "Open full page" : "Open raw"}><ExternalLink /></Button>
				<Button variant="ghost" size="icon-sm" href={raw(path, "&dl=1")} download={name} aria-label="download" title="Download"><Download /></Button>
			{/if}
			<Button variant="ghost" size="icon-sm" aria-label="close" title="Close (Esc)" onclick={closeFile}><X /></Button>
		</header>
		<div bind:this={body} class="flex-1 overflow-y-auto overscroll-contain">
			{#if view.kind === "loading"}<div class="p-6 text-sm text-muted-foreground">loading…</div>
			{:else if view.kind === "error"}<div class="p-6 text-sm text-destructive">{view.msg}</div>
			{:else if view.kind === "md"}
				<article class="doc mx-auto max-w-3xl px-6 py-8">{@html view.html}</article>
				{#if view.cut}<div class="px-6 pb-8 text-sm text-muted-foreground">Showing the first {size(MD_MAX)} of {size(view.size)}. Download for the rest.</div>{/if}
			{:else if view.kind === "text"}
				<pre class="min-h-full p-4 font-mono text-xs leading-relaxed"><code class="hljs !bg-transparent !p-0">{@html view.html}</code></pre>
				{#if view.loaded < view.size}<div class="px-4 pb-6"><Button variant="secondary" size="sm" onclick={more}>Load more ({size(view.loaded)} of {size(view.size)})</Button></div>{/if}
			{:else if view.kind === "image"}<div class="flex min-h-full items-center justify-center p-4"><img src={raw(path)} alt={name} class="max-h-full max-w-full rounded" /></div>
			{:else if view.kind === "pdf"}<iframe src={raw(path)} title={name} class="h-full w-full border-0 bg-white"></iframe>
			{:else if view.kind === "html"}
				<!-- No allow-same-origin: the page gets an opaque origin, so its JS can't reach the app's cookies, storage or API. -->
				<iframe src={pageUrl(path)} title={name} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads" referrerpolicy="no-referrer" class="h-full w-full border-0 bg-white"></iframe>
			{:else if view.kind === "binary"}<div class="p-6 text-sm text-muted-foreground">Binary file ({size(view.size)}). Use download.</div>
			{:else if view.kind === "dir"}
				<ul class="p-2 text-sm">
					{#each view.entries as e (e.name)}
						<li><button class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-accent" onclick={() => openFile(path.replace(/\/+$/, "") + "/" + e.name + (e.dir ? "/" : ""))}>
							{#if e.dir}<Folder class="size-4 shrink-0 text-muted-foreground" />{:else}<FileText class="size-4 shrink-0 text-muted-foreground" />{/if}
							<span class="truncate">{e.name}</span>
							<span class="ml-auto shrink-0 text-xs text-muted-foreground">{e.dir ? "" : size(e.size)}</span>
						</button></li>
					{:else}<li class="px-3 py-2 text-muted-foreground">empty</li>{/each}
					{#if view.total > view.entries.length}<li class="px-3 py-2 text-xs text-muted-foreground">{view.total - view.entries.length} more not shown</li>{/if}
				</ul>
			{/if}
		</div>
	{/if}
</aside>
