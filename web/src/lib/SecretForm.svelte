<script lang="ts">
	import { Check, KeyRound } from "@lucide/svelte";
	import { Button } from "$lib/components/ui/button";
	import * as Card from "$lib/components/ui/card";
	import { Input } from "$lib/components/ui/input";
	import * as Select from "$lib/components/ui/select";
	import { TTLS } from "../../../src/app/ttl.ts";

	let { token, name, why }: { token: string; name: string; why: string } = $props();
	let value = $state(""), ttl = $state("0"), saving = $state(false), saved = $state(false), error = $state("");
	const label = $derived(TTLS.find(([, s]) => String(s) === ttl)?.[0]);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		saving = true; error = "";
		const r = await fetch(`/s/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value, ttl: Number(ttl) || undefined }) });
		saving = false; value = "";
		if (r.ok) saved = true; else error = await r.text();
	}
</script>

<Card.Root class="gap-4 border-warn/25 py-5">
	<Card.Header class="px-5">
		<Card.Title class="flex items-center gap-2 text-[15px]">
			<KeyRound class="size-4 text-warn" />raubot needs <code class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px]">{name}</code>
		</Card.Title>
		<Card.Description>{why}</Card.Description>
	</Card.Header>
	<Card.Content class="px-5">
		{#if saved}
			<p class="flex items-center gap-2 text-sm text-emerald-400"><Check class="size-4" />Saved. raubot can use it now.</p>
		{:else}
			<form onsubmit={save} class="flex flex-col gap-3">
				<Input type="password" bind:value placeholder="Paste the secret" autocomplete="off" required class="h-10 font-mono" />
				<div class="flex gap-2">
					<Select.Root type="single" bind:value={ttl}>
						<Select.Trigger class="h-10! flex-1">{label}</Select.Trigger>
						<Select.Content>
							{#each TTLS as [l, s]}<Select.Item value={String(s)} label={l}>{l}</Select.Item>{/each}
						</Select.Content>
					</Select.Root>
					<Button type="submit" class="h-10 px-5" disabled={saving || !value}>{saving ? "Saving…" : "Save"}</Button>
				</div>
				{#if error}<p class="text-sm text-destructive">{error}</p>{/if}
				<p class="text-xs text-muted-foreground">Encrypted at rest. raubot can use it, but never sees it.</p>
			</form>
		{/if}
	</Card.Content>
</Card.Root>
