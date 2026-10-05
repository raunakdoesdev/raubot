<script lang="ts">
	import type { Snippet } from "svelte";
	let { title = "raubot", href, children, lead }: { title?: string; href?: string; children?: Snippet; lead?: Snippet } = $props();
</script>

<header class="shrink-0 border-b bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur">
	<div class="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4">
		{@render lead?.()}
		{#if href}<a {href} class="font-semibold tracking-tight">raubot</a><span class="text-muted-foreground">/</span>{/if}
		<span class="font-semibold tracking-tight">{title}</span>
		<div class="flex min-w-0 flex-1 items-center justify-end gap-2">{@render children?.()}</div>
	</div>
</header>
