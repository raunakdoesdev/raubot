<script lang="ts">
	import { tick } from "svelte";
	import { Input } from "$lib/components/ui/input";
	import Header from "$lib/Header.svelte";
	import Node from "$lib/tree/Node.svelte";
	import { color, get, kindColor, rows, when, type Hit, type P, type Top } from "$lib/tree/tree";

	const TABS = [["tree", "Tree"], ["view", "Model's view"], ["cache", "Cache"]] as const;
	let top = $state<Top>(), tab = $state<(typeof TABS)[number][0]>("tree");
	let q = $state(""), hits = $state<Hit[]>(), timer: ReturnType<typeof setTimeout>;
	get<Top>().then((t) => (top = t));

	const pct = $derived(top ? Math.min(100, (100 * top.bytes) / top.budget) : 0);
	const deepest = $derived(top ? Math.max(0, ...top.view.map((p) => p.l)) : 0);

	/** Opens the path from a root down to node (l, i), then highlights it. */
	async function reveal(l: number, i: number) {
		tab = "tree"; hits = undefined;
		const id = i << l, root = top!.roots.find((p) => id >= p.id && id < p.id + p.n);
		if (!root) return;
		await tick();
		for (let k = root.l; k > l; k--) { await rows.get(`${k}:${id >> k}`)?.toggle(true); await tick(); }
		rows.get(`${l}:${i}`)?.flash();
	}
	function search() {
		clearTimeout(timer);
		timer = setTimeout(async () => { const s = q.trim(); hits = s ? (await get<{ hits: Hit[] }>(`?find=${encodeURIComponent(s)}`)).hits : undefined; }, 200);
	}
	const hit = (u: Top["usage"][number]) => { const t = u.input + u.cacheRead + u.cacheWrite; return t ? Math.round((100 * u.cacheRead) / t) : 0; };
</script>

<Header title="memory" href="/">
	{#if top}<span class="truncate text-sm text-muted-foreground">{top.log} messages · {top.view.length} lines{top.pending ? " · summarizing…" : ""}</span>{/if}
</Header>

<div class="mx-auto w-full max-w-3xl px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
	{#if top}
		<section class="flex flex-col gap-3 pt-5 pb-4">
			<div class="flex flex-col gap-1 text-sm sm:flex-row sm:items-baseline sm:justify-between">
				<span class="font-medium">View <span class="text-muted-foreground">{(top.bytes / 1000).toFixed(1)} of {(top.budget / 1000).toFixed(0)} KB</span></span>
				<span class="text-xs text-muted-foreground">{deepest ? `oldest messages folded into L${deepest} summaries` : "all raw; the oldest fold into summaries once it's full"}</span>
			</div>
			<div class="h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-sky-400" style:width="{pct}%"></div></div>
			<div class="flex h-5 gap-px overflow-hidden rounded-md" title="What the model sees, oldest → newest. Tap to jump.">
				{#each top.view as p (`${p.l}:${p.i}`)}
					<button aria-label="L{p.l} #{p.id}" title="L{p.l} #{p.id}+{p.n}" class="min-w-px opacity-80 hover:opacity-100"
						style:flex={Math.min(p.n, top.log - p.id)} style:background={p.l ? color(p) : "var(--muted)"} onclick={() => reveal(p.l, p.i)}></button>
				{/each}
			</div>
		</section>

		<nav class="sticky top-0 z-10 -mx-4 flex gap-1 border-b bg-background/90 px-4 py-2 backdrop-blur">
			{#each TABS as [t, name] (t)}
				<button onclick={() => (tab = t)} class="rounded-md px-3 py-1.5 text-sm transition-colors {tab === t ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}">{name}</button>
			{/each}
		</nav>

		<div class="pt-4" hidden={tab !== "tree"}>
			<Input bind:value={q} oninput={search} placeholder="Search messages…" autocomplete="off" class="h-10" />
			{#if hits}
				<div class="mt-2 flex flex-col rounded-xl border bg-card p-1">
					{#each hits as h (h.id)}
						<button onclick={() => reveal(0, h.id)} class="flex flex-col gap-1 rounded-lg px-3 py-2 text-left hover:bg-accent/60">
							<span class="font-mono text-[11px] text-muted-foreground"><span class="mr-1.5 rounded-md px-1.5 py-px font-semibold text-background" style:background={kindColor(h.kind)}>{h.kind}</span>#{h.id} · {when(h.date)}</span>
							<span class="line-clamp-3 text-sm [overflow-wrap:anywhere] text-muted-foreground">{h.snippet}</span>
						</button>
					{:else}<p class="px-3 py-2 text-sm text-muted-foreground">No matches.</p>{/each}
				</div>
			{/if}
			<div class="my-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
				<span><span class="text-sky-400">● in view</span> the model sees this line</span>
				<span><span class="text-muted-foreground/50">● folded</span> seen only inside a bigger summary</span>
				<span>no mark: the model sees finer lines below</span>
			</div>
			<div class="-mx-2">{#each top.roots as p (`${p.l}:${p.i}`)}<Node {p} />{/each}</div>
		</div>

		<div class="-mx-2 pt-3" hidden={tab !== "view"}>{#each top.view as p (`${p.l}:${p.i}`)}<Node {p} track={false} />{/each}</div>

		<div class="overflow-x-auto pt-4" hidden={tab !== "cache"}>
			<table class="w-full font-mono text-xs">
				<thead class="text-muted-foreground"><tr>{#each ["time", "input", "cache read", "cache write", "output", "hit"] as h}<th class="border-b px-2 py-2 text-right font-medium">{h}</th>{/each}</tr></thead>
				<tbody>
					{#each top.usage.slice().reverse() as u (u.date)}
						<tr class="hover:bg-accent/40">
							<td class="border-b px-2 py-1.5 text-right">{new Date(u.date).toLocaleTimeString()}</td>
							{#each [u.input, u.cacheRead, u.cacheWrite, u.output] as v}<td class="border-b px-2 py-1.5 text-right tabular-nums">{v}</td>{/each}
							<td class="border-b px-2 py-1.5 text-right tabular-nums">{hit(u)}%</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
