<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { FileTree } from "@pierre/trees";
	import { listUrl } from "$lib/files.svelte";

	/**
	 * A box's whole filesystem as a lazy, live tree (@pierre/trees). Folders load when expanded; every loaded, visible folder is
	 * re-listed every few seconds so new and changed files show up without a refresh. Tree ids are box paths without the leading
	 * slash, folders with a trailing one ("workspace/research/").
	 */
	let { box, selected = null, live = true, onselect, onchange, onerror }: {
		box: number; selected?: string | null; live?: boolean;
		onselect: (path: string) => void;
		/** A file's size or mtime changed (absolute path, "size:mtime"). */
		onchange?: (path: string, version: string) => void;
		onerror?: (msg: string) => void;
	} = $props();

	type Entry = { name: string; dir: boolean; size: number; mtime: number; link?: boolean };
	type Listing = { path: string; entries: Entry[]; error?: string; status?: number };

	let mount: HTMLDivElement;
	let tree: FileTree;
	/** Metadata per tree id; children per loaded folder id ("" = root). */
	const meta = new Map<string, Entry>(), kids = new Map<string, Set<string>>();
	const loading = new Set<string>();
	const abs = (id: string) => "/" + id.replace(/\/$/, "");
	const idOf = (p: string, dir: boolean) => (p === "/" ? "" : p.replace(/^\/+/, "").replace(/\/+$/, "") + (dir ? "/" : ""));
	const human = (n: number) => (n < 1024 ? n + " B" : n < 2 ** 20 ? (n / 1024).toFixed(0) + " KB" : n < 2 ** 30 ? (n / 2 ** 20).toFixed(1) + " MB" : (n / 2 ** 30).toFixed(1) + " GB");
	const ago = (t: number) => { const s = Date.now() / 1000 - t; return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : s < 86400 * 365 ? Math.floor(s / 86400) + "d" : Math.floor(s / 86400 / 365) + "y"; };

	async function lists(paths: string[]): Promise<Record<string, Listing>> {
		const r = await fetch(listUrl("paths=" + encodeURIComponent(paths.join("\n")), box));
		if (!r.ok) throw new Error(r.status === 404 ? await r.text() : "HTTP " + r.status);
		return (await r.json()).lists;
	}

	/** Fold one folder's fresh listing into the tree: add new, drop gone, note changed files. */
	function apply(dirId: string, l: Listing) {
		if (l.error) { if (l.status === 404 && dirId && kids.has(dirId)) { try { tree.remove(dirId, { recursive: true }); } catch {} kids.delete(dirId); } return; }
		const now = new Set<string>(), ops: { type: "add" | "remove"; path: string; recursive?: boolean }[] = [];
		const old = kids.get(dirId);
		for (const e of l.entries) {
			const id = dirId + e.name + (e.dir ? "/" : "");
			now.add(id);
			const prev = meta.get(id);
			meta.set(id, e);
			if (!old?.has(id) && !tree.getItem(id)) ops.push({ type: "add", path: id });
			else if (prev && !e.dir && (prev.size !== e.size || prev.mtime !== e.mtime)) onchange?.(abs(id), e.size + ":" + e.mtime);
		}
		for (const id of old ?? []) if (!now.has(id)) { ops.push({ type: "remove", path: id, recursive: true }); meta.delete(id); kids.delete(id); }
		kids.set(dirId, now);
		if (ops.length) { try { tree.batch(ops); } catch { for (const o of ops) try { o.type === "add" ? tree.add(o.path) : tree.remove(o.path, { recursive: true }); } catch {} } }
	}

	async function load(dirIds: string[]) {
		const todo = dirIds.filter((d) => !loading.has(d));
		if (!todo.length) return;
		for (const d of todo) loading.add(d);
		try {
			const got = await lists(todo.map((d) => (d ? abs(d) : "/")));
			for (const d of todo) { const l = got[d ? abs(d) : "/"]; if (l) apply(d, l); }
			onerror?.("");
		} catch (e) { onerror?.(e instanceof Error ? e.message : String(e)); }
		finally { for (const d of todo) loading.delete(d); }
	}

	const expanded = (id: string) => { const it = tree.getItem(id); return !!it && it.isDirectory() && it.isExpanded(); };
	/** Folders open on screen whose children we haven't fetched yet. */
	function unloaded() {
		const out: string[] = [];
		for (const [id, e] of meta) if (e.dir && !kids.has(id) && expanded(id)) out.push(id);
		return out;
	}
	/** Loaded folders still visible (root + expanded chain): what live polling re-lists. */
	function visible() {
		const out = [""];
		for (const id of kids.keys()) if (id && expanded(id)) { const parts = id.split("/").filter(Boolean); let ok = true; for (let i = 1; i < parts.length; i++) if (!expanded(parts.slice(0, i).join("/") + "/")) { ok = false; break; } if (ok) out.push(id); }
		return out;
	}

	/** Expand down to a path, loading each folder on the way, then select it. */
	export async function reveal(path: string) {
		const parts = path.split("/").filter(Boolean);
		for (let i = 0; i < parts.length; i++) {
			const isLast = i === parts.length - 1;
			const dir = parts.slice(0, i).join("/") + (i ? "/" : "");
			if (!kids.has(dir)) await load([dir]);
			const id = parts.slice(0, i + 1).join("/") + "/";
			if (!isLast || path.endsWith("/") || meta.get(id)?.dir) {
				const it = tree.getItem(id);
				if (it?.isDirectory()) { it.expand(); if (!kids.has(id)) await load([id]); }
			}
		}
		const fid = idOf(path, false), did = fid + "/";
		const id = tree.getItem(did) ? did : fid;
		const it = tree.getItem(id);
		if (it) { suppress = true; it.select(); tree.scrollToPath(id, { focus: false }); suppress = false; }
	}

	let suppress = false, timer: ReturnType<typeof setInterval> | undefined, scan = false;
	onMount(() => {
		tree = new FileTree({
			paths: [],
			search: true,
			initialExpansion: "closed",
			flattenEmptyDirectories: false,
			itemHeight: 26,
			density: "compact",
			onSelectionChange: (sel) => { if (!suppress && sel.length === 1) { const id = sel[0]; onselect(abs(id) + (id.endsWith("/") ? "/" : "")); } },
			renderRowDecoration: ({ item }) => {
				const e = meta.get(item.path) ?? meta.get(item.path + "/");
				if (!e) return null;
				const fresh = !e.dir && Date.now() / 1000 - e.mtime < 120;
				return { text: (fresh ? "● " : "") + (e.dir ? ago(e.mtime) : human(e.size) + " · " + ago(e.mtime)), title: (e.link ? "symlink · " : "") + new Date(e.mtime * 1000).toLocaleString() + (e.dir ? "" : " · " + e.size.toLocaleString() + " bytes") };
			},
			unsafeCSS: `[data-item-section="decoration"] { font-size: 11px; font-variant-numeric: tabular-nums; }`,
		});
		tree.render({ containerWrapper: mount });
		// Expanding a folder fires a tree change: fetch any open-but-unloaded folders then.
		tree.subscribe(() => { if (scan) return; scan = true; queueMicrotask(() => { scan = false; const u = unloaded(); if (u.length) void load(u); }); });
		void (async () => {
			await load([""]);
			await reveal(selected ?? "/workspace/");
		})();
		timer = setInterval(() => { if (live && !document.hidden) void load(visible()); }, 2500);
	});
	onDestroy(() => { clearInterval(timer); tree?.cleanUp(); });

	// Selection driven from outside (breadcrumb, a clicked path): reveal it.
	let last = selected;
	$effect(() => { const s = selected; if (tree && s && s !== last) { last = s; void reveal(s); } });

	/** Server-side search from a folder; hits are revealed in the tree. */
	export async function find(q: string, from = "/") {
		const r = await fetch(listUrl("find=" + encodeURIComponent(q) + "&path=" + encodeURIComponent(from), box));
		if (!r.ok) throw new Error(await r.text());
		return (await r.json()) as { hits: { path: string; dir: boolean }[]; partial: boolean };
	}
</script>

<div bind:this={mount} class="trees h-full min-h-0"></div>

<style>
	.trees {
		--trees-bg-override: var(--background);
		--trees-fg-override: var(--foreground);
		--trees-fg-muted-override: var(--muted-foreground);
		--trees-border-color-override: var(--border);
		--trees-accent-override: var(--primary);
		--trees-font-family-override: inherit;
		--trees-font-size-override: 13px;
		--trees-padding-inline-override: 8px;
		--trees-search-bg-override: var(--muted);
		--trees-input-bg-override: var(--muted);
		--trees-search-fg-override: var(--foreground);
	}
</style>
