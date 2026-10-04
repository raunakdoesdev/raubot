<script lang="ts">
	import * as Card from "$lib/components/ui/card";
	import SecretForm from "$lib/SecretForm.svelte";

	const token = location.pathname.split("/").pop()!;
	const ask = fetch(`/s/${token}.json`).then((r) => (r.ok ? (r.json() as Promise<{ name: string; why: string }>) : undefined));
</script>

<main class="grid min-h-dvh place-items-center p-4">
	<div class="flex w-full max-w-md flex-col gap-4">
		<div class="px-1 text-sm font-semibold tracking-tight text-muted-foreground">raubot</div>
		{#await ask then a}
			{#if a}
				<SecretForm {token} {...a} />
			{:else}
				<Card.Root class="py-5"><Card.Header class="px-5">
					<Card.Title class="text-[15px]">This link has expired</Card.Title>
					<Card.Description>It was already used, or it's more than 7 days old. Ask raubot for a new one.</Card.Description>
				</Card.Header></Card.Root>
			{/if}
		{/await}
	</div>
</main>
