<script lang="ts">
	import { ChevronRight, ExternalLink } from "@lucide/svelte";

	/** A signed Devin callback ("[devin <id> <status>] purpose\nsummary\nurl"): a muted, collapsible notification, not a user bubble. */
	let { text, pending = false }: { text: string; pending?: boolean } = $props();

	let open = $state(false);
	const m = $derived(/^\[devin ([\w-]+) (\w[\w ]*?)\] ?(.*)/.exec(text.split("\n")[0]));
	const status = $derived(m?.[2] ?? "");
	const purpose = $derived(m?.[3] ?? text.split("\n")[0]);
	const url = $derived(/https:\/\/app\.devin\.ai\/sessions\/\w+/.exec(text)?.[0]);
	const body = $derived(text.split("\n").slice(1).filter((l) => l.trim() !== url).join("\n").trim());
	const tone = $derived(status === "done" ? "text-emerald-500" : status === "failed" ? "text-red-500" : "text-amber-500");
</script>

<div class="-my-2 min-w-0 {pending ? 'opacity-70' : ''}">
	<div class="flex w-full min-w-0 items-center gap-1.5 py-1 text-xs text-muted-foreground">
		<button type="button" onclick={() => (open = !open)} disabled={!body} class="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground disabled:hover:text-muted-foreground">
			<ChevronRight class="size-3.5 shrink-0 transition-transform {open ? 'rotate-90' : ''} {body ? '' : 'invisible'}" />
			<span class="shrink-0 rounded border px-1 font-mono text-[10px] tracking-wide uppercase">Devin</span>
			{#if status}<span class="shrink-0 font-mono {tone}">{status}</span>{/if}
			<span class="min-w-0 flex-1 truncate">{purpose}</span>
		</button>
		{#if pending}<span class="shrink-0">queued</span>{/if}
		{#if url}<a href={url} target="_blank" rel="noopener noreferrer" class="flex shrink-0 items-center gap-0.5 hover:text-foreground">session <ExternalLink class="size-3" /></a>{/if}
	</div>
	{#if open && body}
		<div class="mt-1 mb-2 border-l pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{body}</div>
	{/if}
</div>
