<script lang="ts">
	import { tick } from "svelte";
	import { Bot, Monitor, Search } from "@lucide/svelte";

	type Row = { id: number; task: string; computer: boolean; status: "running" | "idle"; started: string };
	let { open = $bindable(false), onpick }: { open?: boolean; onpick: (id: number) => void } = $props();
	let rows = $state<Row[]>([]), q = $state(""), at = $state(0), loading = $state(false), err = $state("");
	let input = $state<HTMLInputElement>(), list = $state<HTMLElement>();

	const title = (t: string) => t.replace(/^\s*(task:\s*)?/i, "").split("\n")[0];
	const ago = (iso: string) => {
		const s = (Date.now() - Date.parse(iso)) / 1000;
		return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
	};
	/** Every word must appear in the task or match the id. */
	const hits = $derived.by(() => {
		const words = q.toLowerCase().replace(/^#/, "").split(/s+/).filter(Boolean);
		return rows.filter((r) => words.every((w) => r.task.toLowerCase().includes(w) || String(r.id) === w)).slice(0, 50);
	});
	$effect(() => { q; at = 0; });

	async function load() {
		loading = true; err = "";
		try {
			const r = await fetch("/agents/all.json");
			if (!r.ok) throw new Error(await r.text());
			rows = await r.json();
		} catch (e) { err = String(e).slice(0, 160); }
		loading = false;
	}
	$effect(() => { if (open) { q = ""; load(); tick().then(() => input?.focus()); } });

	const pick = (id: number) => { open = false; onpick(id); };
	function key(e: KeyboardEvent) {
		if (e.key === "Escape") { e.preventDefault(); open = false; }
		else if (e.key === "ArrowDown") { e.preventDefault(); at = Math.min(at + 1, hits.length - 1); scroll(); }
		else if (e.key === "ArrowUp") { e.preventDefault(); at = Math.max(at - 1, 0); scroll(); }
		else if (e.key === "Enter" && hits[at]) { e.preventDefault(); pick(hits[at].id); }
	}
	const scroll = () => tick().then(() => list?.querySelector("[data-on]")?.scrollIntoView({ block: "nearest" }));
</script>

{#if open}
	<div class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh]" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) open = false; }}>
		<div class="w-full max-w-xl overflow-hidden rounded-xl border bg-popover shadow-2xl" role="dialog" aria-label="search subagents">
			<div class="flex items-center gap-2 border-b px-3">
				<Search class="size-4 shrink-0 text-muted-foreground" />
				<input bind:this={input} bind:value={q} onkeydown={key} placeholder="Search subagents by task or #id" autocomplete="off"
					class="h-12 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground" />
				<kbd class="hidden shrink-0 rounded border px-1.5 text-xs text-muted-foreground sm:block">esc</kbd>
			</div>
			<div bind:this={list} class="max-h-[55vh] overflow-y-auto p-1.5 text-sm">
				{#each hits as r, k (r.id)}
					<button data-on={k === at ? "" : undefined} class="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left {k === at ? 'bg-accent' : ''}"
						onmousemove={() => (at = k)} onclick={() => pick(r.id)} title={r.task}>
						<span class="size-2 shrink-0 rounded-full {r.status === 'running' ? 'bg-emerald-400' : 'bg-muted-foreground/40'}"></span>
						<span class="truncate">{title(r.task)}</span>
						<span class="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
							{#if r.computer}<Monitor class="size-3" />{:else}<Bot class="size-3" />{/if}#{r.id} · {ago(r.started)}
						</span>
					</button>
				{:else}
					<div class="px-3 py-6 text-center text-muted-foreground">{loading ? "loading…" : err || "no matching subagents"}</div>
				{/each}
			</div>
		</div>
	</div>
{/if}
