<script lang="ts">
	import { ChevronRight } from "@lucide/svelte";
	import Node from "./Node.svelte";
	import { color, get, label, meta, rows, type P } from "./tree";

	let { p, track = true }: { p: P; track?: boolean } = $props();
	let open = $state(false), kids = $state<P[]>(), raw = $state<string>(), hl = $state(false), row: HTMLElement;

	async function toggle(want = !open) {
		if (want && kids === undefined && raw === undefined) {
			const c = await get<{ raw?: string; children?: P[] }>(`?l=${p.l}&i=${p.i}`);
			if (c.raw !== undefined) raw = c.raw; else kids = c.children;
		}
		open = want;
	}
	const flash = () => { row.scrollIntoView({ block: "center", behavior: "smooth" }); hl = true; setTimeout(() => (hl = false), 1600); };
	$effect(() => {
		if (!track) return;
		const key = `${p.l}:${p.i}`;
		rows.set(key, { toggle, flash });
		return () => rows.delete(key);
	});
	const text = $derived(p.text == null ? "summarizing…" : p.l ? p.text : p.text.replace(/^\w+: /, ""));
</script>

<div>
	<button bind:this={row} onclick={() => toggle()}
		class="grid w-full grid-cols-[14px_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60 {hl ? 'bg-sky-500/15' : ''}">
		<ChevronRight class="size-3.5 text-muted-foreground transition-transform {open ? 'rotate-90' : ''}" />
		<span class="w-fit rounded-md px-1.5 py-px font-mono text-[11px] font-semibold text-background" style:background={color(p)}>{label(p)}</span>
		<span class="truncate font-mono text-[11px] text-muted-foreground">
			{meta(p)}
			{#if p.seen === "view"}<span class="ml-1 text-sky-400">● in view</span>{:else if p.seen !== "open"}<span class="ml-1 text-muted-foreground/50">● folded</span>{/if}
		</span>
		<span class="col-start-3 text-sm leading-relaxed [overflow-wrap:anywhere] {p.text == null ? 'text-warn italic' : ''}">{text}</span>
	</button>
	{#if open}
		{#if raw !== undefined}
			<pre class="my-1 ml-7 max-h-[60vh] overflow-auto rounded-lg border bg-card p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{raw}</pre>
		{:else}
			<div class="ml-3.5 border-l pl-1.5">{#each kids ?? [] as k (`${k.l}:${k.i}`)}<Node p={k} {track} />{/each}</div>
		{/if}
	{/if}
</div>
