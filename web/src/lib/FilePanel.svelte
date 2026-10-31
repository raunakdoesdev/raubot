<script lang="ts">
	import { ChevronRight, Download, ExternalLink, FolderTree, MessageSquarePlus, Play, Search, Send, X } from "@lucide/svelte";
	import { Button } from "$lib/components/ui/button";
	import BoxTree from "$lib/BoxTree.svelte";
	import Preview from "$lib/Preview.svelte";
	import { closeFile, openFile, pageUrl, raw, viewer } from "$lib/files.svelte";

	/**
	 * The right-hand file browser: one agent's whole box (tree + live preview), and a note box that sends feedback on the
	 * open file straight to that agent (it reads it at its next step). Docked on wide screens, a sheet on phones.
	 */
	let { title = "" }: { title?: string } = $props();

	const box = $derived(viewer.box), path = $derived(viewer.path);
	const isDir = $derived(!!path && path.endsWith("/"));
	const name = $derived(path?.split("/").filter(Boolean).pop() ?? "");
	const crumbs = $derived.by(() => {
		const parts = (path ?? "").split("/").filter(Boolean);
		return [{ name: "/", path: "/" }, ...parts.map((p, i) => ({ name: p, path: "/" + parts.slice(0, i + 1).join("/") + (i < parts.length - 1 || isDir ? "/" : "") }))];
	});

	let live = $state(true), err = $state(""), version = $state("");
	let treeRef: BoxTree | undefined = $state();
	const changed = (p: string, v: string) => { if (p === path?.replace(/\/$/, "")) version = v; };
	$effect(() => { void path; version = ""; });

	// Width: draggable, remembered.
	let width = $state(Number(localStorage.getItem("raubot:files:w")) || 760), drag = false;
	const down = (e: PointerEvent) => { drag = true; (e.target as Element).setPointerCapture(e.pointerId); };
	const move = (e: PointerEvent) => { if (drag) width = Math.max(380, Math.min(innerWidth - 360, innerWidth - e.clientX)); };
	const up = () => { if (drag) { drag = false; localStorage.setItem("raubot:files:w", String(Math.round(width))); } };

	// Search across the box (server-side), from the open folder.
	let q = $state(""), hits = $state<{ path: string; dir: boolean }[]>([]), searching = $state(false), partial = $state(false);
	async function search() {
		if (q.trim().length < 2 || !treeRef) { hits = []; return; }
		searching = true;
		try {
			const from = path ? (isDir ? path : path.replace(/[^/]*$/, "")) : "/workspace/";
			const r = await treeRef.find(q.trim(), from.length > 1 ? from.replace(/\/$/, "") : "/");
			hits = r.hits; partial = r.partial;
		} catch (e) { err = String(e).slice(0, 160); } finally { searching = false; }
	}

	// Feedback on the open file, to the agent working in this box.
	let note = $state(""), sending = $state(false), sent = $state("");
	async function feedback() {
		if (!note.trim() || !path) return;
		sending = true; sent = "";
		try {
			const r = await fetch("/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ box: String(box), path: path.replace(/\/$/, "") || "/", message: note.trim() }) });
			if (!r.ok) throw new Error(await r.text());
			const ok = (await r.json()).ok;
			sent = ok === "steered" ? "Sent · it reads it at its next step" : ok === "asked" ? "Sent · started a follow-up" : "Sent to raubot";
			note = "";
		} catch (e) { sent = "Not sent: " + String(e).slice(0, 120); } finally { sending = false; }
	}
	const noteKey = (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); feedback(); } };
	const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && viewer.open && !(e.target as Element)?.closest?.("textarea,input")) closeFile(); };
	const who = $derived(box ? `subagent #${box}` : "raubot");
</script>

<svelte:window onkeydown={esc} onpointermove={move} onpointerup={up} />
{#if viewer.open}
	<button class="fixed inset-0 z-40 bg-black/40 lg:hidden" aria-label="close files" onclick={closeFile}></button>
	<aside class="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background pt-[env(safe-area-inset-top)] shadow-2xl sm:w-[min(94vw,52rem)] lg:relative lg:z-auto lg:w-[var(--w)] lg:max-w-none lg:shrink-0 lg:shadow-none" style="--w: {width}px" aria-label="files">
		<div class="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize hover:bg-primary/20 lg:block" role="separator" aria-orientation="vertical" onpointerdown={down}></div>
		<header class="flex h-14 shrink-0 items-center gap-1 border-b px-3">
			<FolderTree class="size-4 shrink-0 text-muted-foreground" />
			<span class="shrink-0 text-sm font-medium" title={title}>{who}</span>
			<nav class="no-scrollbar ml-1 flex min-w-0 flex-1 items-center overflow-x-auto text-sm whitespace-nowrap">
				{#each crumbs as c, i (c.path)}
					{#if i > 1}<ChevronRight class="size-3 shrink-0 text-muted-foreground" />{/if}
					{#if i === crumbs.length - 1 && i}<span class="px-1 font-medium">{c.name}</span>
					{:else}<button class="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground" onclick={() => openFile(c.path)}>{c.name}</button>{/if}
				{/each}
			</nav>
			<Button variant="ghost" size="icon-sm" aria-label={live ? "pause live updates" : "resume live updates"} title={live ? "Live: new files appear as the agent writes them (click to pause)" : "Paused (click for live)"} onclick={() => (live = !live)}>
				{#if live}<span class="relative flex size-2"><span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60"></span><span class="relative inline-flex size-2 rounded-full bg-emerald-400"></span></span>{:else}<Play />{/if}
			</Button>
			{#if path && !isDir}
				<Button variant="ghost" size="icon-sm" href={/\.x?html?$/i.test(path) ? pageUrl(path) : raw(path)} target="_blank" aria-label="open raw" title="Open in a new tab"><ExternalLink /></Button>
				<Button variant="ghost" size="icon-sm" href={raw(path, "&dl=1")} download={name} aria-label="download" title="Download"><Download /></Button>
			{/if}
			<Button variant="ghost" size="icon-sm" aria-label="close" title="Close (Esc)" onclick={closeFile}><X /></Button>
		</header>
		<div class="@container flex min-h-0 flex-1 flex-col">
			<div class="flex min-h-0 flex-1 flex-col @[42rem]:flex-row">
				<div class="flex h-[38%] min-h-0 shrink-0 flex-col border-b @[42rem]:h-auto @[42rem]:w-72 @[42rem]:border-r @[42rem]:border-b-0">
					<form class="flex shrink-0 items-center gap-1 border-b px-2 py-1.5" onsubmit={(e) => { e.preventDefault(); search(); }}>
						<Search class="size-3.5 shrink-0 text-muted-foreground" />
						<input bind:value={q} placeholder="Search whole box from here (Enter)" class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" oninput={() => { if (!q) hits = []; }} />
						{#if hits.length || searching}<button type="button" class="text-xs text-muted-foreground hover:text-foreground" onclick={() => { q = ""; hits = []; }}>{searching ? "…" : "clear"}</button>{/if}
					</form>
					{#if hits.length}
						<ul class="max-h-48 shrink-0 overflow-y-auto border-b py-1 text-xs">
							{#each hits as h (h.path)}<li><button class="block w-full truncate px-3 py-1 text-left font-mono hover:bg-accent" title={h.path} onclick={() => openFile(h.path + (h.dir ? "/" : ""))}>{h.path}{h.dir ? "/" : ""}</button></li>{/each}
							{#if partial}<li class="px-3 py-1 text-muted-foreground">more matches not shown, narrow the search</li>{/if}
						</ul>
					{/if}
					{#if err}<div class="shrink-0 px-3 py-1.5 text-xs text-destructive">{err}</div>{/if}
					{#key box}<div class="min-h-0 flex-1"><BoxTree bind:this={treeRef} {box} selected={path} {live} onselect={(p) => openFile(p)} onchange={changed} onerror={(m) => (err = m)} /></div>{/key}
				</div>
				<div class="flex min-h-0 min-w-0 flex-1 flex-col">
					<div class="min-h-0 flex-1">
						{#if path}<Preview {path} {box} {version} onopen={(p) => openFile(p)} />
						{:else}<div class="p-6 text-sm text-muted-foreground">Pick a file to preview it. Files update live while {who} works.</div>{/if}
					</div>
					{#if path}
						<form class="shrink-0 border-t p-2" onsubmit={(e) => { e.preventDefault(); feedback(); }}>
							<div class="flex items-end gap-1 rounded-xl border bg-card p-1.5 focus-within:ring-[3px] focus-within:ring-ring/30">
								<MessageSquarePlus class="mb-1.5 ml-1 size-4 shrink-0 text-muted-foreground" />
								<textarea bind:value={note} onkeydown={noteKey} rows="1" placeholder={`Feedback on ${name || "this folder"} for ${who}`} class="block max-h-32 min-h-8 w-full resize-y bg-transparent px-1.5 py-1 text-sm outline-none placeholder:text-muted-foreground"></textarea>
								<Button type="submit" size="icon-sm" class="rounded-full" aria-label="send feedback" disabled={!note.trim() || sending}><Send /></Button>
							</div>
							{#if sent}<div class="px-2 pt-1 text-xs {sent.startsWith('Not') ? 'text-destructive' : 'text-muted-foreground'}">{sent}</div>{/if}
						</form>
					{/if}
				</div>
			</div>
		</div>
	</aside>
{/if}
