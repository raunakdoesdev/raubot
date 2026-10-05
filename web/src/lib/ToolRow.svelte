<script lang="ts">
	import { Check, ChevronRight, LoaderCircle, X } from "@lucide/svelte";
	import hljs from "highlight.js/lib/common";
	import { dur, type Run, traces } from "$lib/traces.svelte";

	/** One tool call in a transcript: collapsed to a line; expanded shows the code, its nested calls (lazy) and the result. */
	let { name, arg = "", code = "", body = "", echo = "", run, live = true }: { name: string; arg?: string; code?: string; body?: string; echo?: string; run?: Run; live?: boolean } = $props();

	let open = $state(false), shown = $state(150), more = $state(false);
	const opened = $state<Record<number, boolean>>({});
	const failedEcho = $derived(/^(\w+: )?Script failed|^\[job \d+ (failed|timed out|cancelled)\]/.test(echo));
	const status = $derived(run?.status ?? (echo ? (failedEcho ? "failed" : "ok") : undefined));
	const hl = $derived(open && code ? hljs.highlight(code.length > 30_000 ? code.slice(0, 30_000) : code, { language: "javascript" }).value : "");
	const ECHO = 4000;
	const shownEcho = $derived(more || echo.length <= ECHO ? echo : echo.slice(0, ECHO));

	function toggle() {
		open = !open;
		if (open && run) void traces.load(run.run);
	}
	function toggleCall(id: number) {
		opened[id] = !opened[id];
		if (opened[id] && run) void traces.loadBody(run.run, id);
	}
	// Subagent runs don't stream: refresh an open running one.
	$effect(() => {
		if (!open || !run || live || run.status !== "running") return;
		const id = run.run, t = setInterval(() => void traces.load(id, true), 2000);
		return () => clearInterval(t);
	});
	// A run first seen mid-way (after a reload) is fetched in full once it ends, if open.
	$effect(() => { if (open && run && run.status !== "running" && !run.full) void traces.load(run.run); });
	const cut = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);
</script>

{#snippet icon(s: string | undefined)}
	{#if s === "running"}<LoaderCircle class="size-3 shrink-0 animate-spin text-sky-500" />
	{:else if s === "ok"}<Check class="size-3 shrink-0 text-emerald-500" />
	{:else if s === "failed"}<X class="size-3 shrink-0 text-red-500" />{/if}
{/snippet}

<div class="-my-2 min-w-0">
	<button type="button" onclick={toggle} class="group flex w-full min-w-0 items-center gap-1.5 py-1 text-left font-mono text-xs text-muted-foreground hover:text-foreground">
		<ChevronRight class="size-3.5 shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
		{@render icon(status)}
		<span class="shrink-0 text-foreground/70">{name}</span>
		<span class="min-w-0 flex-1 truncate">{arg}</span>
		{#if run?.calls}<span class="shrink-0 tabular-nums">{run.calls} call{run.calls === 1 ? "" : "s"}{#if run.failed}<span class="text-red-500"> · {run.failed} failed</span>{/if}</span>{/if}
		{#if run?.ms !== undefined}<span class="shrink-0 tabular-nums">{dur(run.ms)}</span>{/if}
	</button>
	{#if open}
		<div class="mt-1 mb-2 flex flex-col gap-1.5 border-l pl-3">
			{#if code}
				<pre class="max-h-[40vh] overflow-auto rounded-lg border bg-card p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"><code class="hljs !bg-transparent !p-0">{@html hl}</code></pre>
			{:else if body}
				<pre class="max-h-[40vh] overflow-auto rounded-lg border bg-card p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{cut(body)}</pre>
			{/if}
			{#if run?.list?.length}
				<div class="flex flex-col">
					{#each run.list.slice(0, shown) as c (c.id)}
						<button type="button" onclick={() => toggleCall(c.id)} class="flex w-full min-w-0 items-center gap-1.5 py-0.5 text-left font-mono text-xs text-muted-foreground hover:text-foreground">
							<ChevronRight class="size-3 shrink-0 transition-transform {opened[c.id] ? 'rotate-90' : ''}" />
							{@render icon(c.status)}
							<span class="shrink-0 text-foreground/70">{c.name}</span>
							<span class="min-w-0 flex-1 truncate">{c.arg}</span>
							<span class="shrink-0 tabular-nums">{dur(c.ms)}</span>
						</button>
						{#if opened[c.id]}
							{@const b = traces.bodies[`${run.run}:${c.id}`]}
							<div class="mb-1 ml-4 flex flex-col gap-1">
								{#if b === "loading" || b === undefined}<span class="text-xs text-muted-foreground">loading…</span>
								{:else if typeof b === "string"}<span class="text-xs text-muted-foreground">details unavailable{c.out ? `: ${c.out}` : ""}</span>
								{:else}
									<pre class="max-h-[30vh] overflow-auto rounded-md border bg-card p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{cut(b.args)}</pre>
									{#if b.out !== undefined}<pre class="max-h-[30vh] overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] {c.status === 'failed' ? 'border-red-500/40 bg-red-500/5 text-red-600 dark:text-red-400' : 'bg-card text-muted-foreground'}">{cut(b.out)}</pre>
									{:else if c.status === "running"}<span class="text-xs text-muted-foreground">running…</span>{/if}
								{/if}
							</div>
						{/if}
					{/each}
					{#if run.list.length > shown}<button type="button" class="self-start py-0.5 text-xs text-muted-foreground underline" onclick={() => (shown += 300)}>show {run.list.length - shown} more calls</button>{/if}
					{#if run.calls > run.list.length && run.full}<span class="text-xs text-muted-foreground">{run.calls - run.list.length} more calls not recorded</span>{/if}
				</div>
			{:else if run && run.calls && !run.full}<span class="text-xs text-muted-foreground">loading calls…</span>{/if}
			{#if echo}
				<pre class="max-h-[50vh] overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] {failedEcho ? 'border-red-500/40 bg-red-500/5 text-red-600 dark:text-red-400' : 'bg-card text-muted-foreground'}">{shownEcho}</pre>
				{#if echo.length > ECHO}<button type="button" class="self-start text-xs text-muted-foreground underline" onclick={() => (more = !more)}>{more ? "show less" : `show more (${echo.length - ECHO} chars)`}</button>{/if}
			{/if}
		</div>
	{/if}
</div>
