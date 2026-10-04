<script lang="ts">
	import type { Snippet } from "svelte";
	import { Button } from "$lib/components/ui/button";
	import * as Card from "$lib/components/ui/card";
	import Header from "$lib/Header.svelte";

	type Secret = { name: string; why: string; set: number; expires?: number };
	let executor = $state<{ executor: boolean; tools: number }>(), secrets = $state<Secret[]>(), clearing = $state(false);

	fetch("/settings.json").then((r) => r.json()).then((s) => (executor = s));
	fetch("/secrets.json").then((r) => r.json()).then((s) => (secrets = s));

	const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
	async function remove(name: string) {
		if (confirm(`Remove ${name}?`)) secrets = await (await fetch(`/secrets.json?name=${encodeURIComponent(name)}`, { method: "DELETE" })).json();
	}
	async function reset() {
		if (prompt("This permanently deletes the entire conversation, memory tree and box snapshot. Type CLEAR to confirm.") !== "CLEAR") return;
		clearing = true;
		const r = await fetch("/reset", { method: "POST" });
		if (r.ok) location.href = "/"; else { alert(await r.text()); clearing = false; }
	}
</script>

{#snippet row(title: string, sub: string, action: Snippet, mono = false)}
	<div class="flex items-center gap-4 px-5 py-3.5">
		<div class="min-w-0 flex-1">
			<div class={mono ? "font-mono text-sm" : "text-sm font-medium"}>{title}</div>
			<div class="text-sm text-muted-foreground">{sub}</div>
		</div>
		{@render action()}
	</div>
{/snippet}

{#snippet section(title: string, body: Snippet, desc = "")}
	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b px-5 py-4! gap-1">
			<Card.Title class="text-sm">{title}</Card.Title>
			{#if desc}<Card.Description>{desc}</Card.Description>{/if}
		</Card.Header>
		<Card.Content class="divide-y px-0">{@render body()}</Card.Content>
	</Card.Root>
{/snippet}

<Header title="settings" href="/" />
<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
	{#snippet connections()}
		{#snippet connect()}<Button href="/oauth/start" variant="outline" size="sm">{executor?.executor ? "Reconnect" : "Connect"}</Button>{/snippet}
		{@render row("Executor", executor ? (executor.executor ? `Connected · ${executor.tools} tools` : "Not connected") : "…", connect)}
	{/snippet}
	{@render section("Connections", connections)}

	{#snippet secretRows()}
		{#each secrets ?? [] as s (s.name)}
			{#snippet del()}<Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" onclick={() => remove(s.name)}>Remove</Button>{/snippet}
			{@render row(s.name, `${s.why} · ${s.expires ? `expires ${when(s.expires)}` : "kept until removed"}`, del, true)}
		{:else}
			<p class="px-5 py-4 text-sm text-muted-foreground">{secrets ? "None yet. raubot asks when it needs one." : "…"}</p>
		{/each}
	{/snippet}
	{@render section("Secrets", secretRows, "Encrypted. raubot gets them as env vars in bash, never the values.")}

	{#snippet debug()}
		{#snippet tree()}<Button href="/tree" variant="outline" size="sm">Open</Button>{/snippet}
		{#snippet prompt()}<Button href="/prompt" variant="outline" size="sm">Open</Button>{/snippet}
		{@render row("Memory tree", "What the model sees, and cache stats", tree)}
		{@render row("Prompt", "System prompt and codemode tool description", prompt)}
	{/snippet}
	{@render section("Inspect", debug)}

	{#snippet danger()}
		{#snippet clear()}<Button variant="destructive" size="sm" disabled={clearing} onclick={reset}>{clearing ? "Clearing…" : "Clear"}</Button>{/snippet}
		{@render row("Clear history", "Delete the whole conversation, memory tree and box snapshot", clear)}
	{/snippet}
	{@render section("Danger zone", danger)}
</main>
