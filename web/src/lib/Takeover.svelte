<script lang="ts">
	import { onDestroy } from "svelte";
	import { Button } from "$lib/components/ui/button";

	// The box's live desktop (Boat, Moonlight with clipboard). /takeover/<box> mints a new signed URL and redirects the frame to it;
	// the agent's computer use waits until the hand back.
	let { box, onhandback }: { box: string; onhandback: (steer: string) => Promise<void> | void } = $props();
	let steer = $state(""), busy = $state(false), done = false;
	const release = () => fetch(`/takeover/${box}/release`, { method: "POST", keepalive: true });
	// Closing the tab hands back too, so the agent isn't held for the full 30 minutes.
	const leave = () => { if (!done) navigator.sendBeacon(`/takeover/${box}/release`); };
	addEventListener("pagehide", leave);
	onDestroy(() => removeEventListener("pagehide", leave));

	async function handBack() {
		busy = true;
		const text = steer.trim();
		// Steer first, so it's queued before the paused computer call goes on.
		if (text) await onhandback(text);
		await release().catch(() => {});
		done = true;
		await onhandback("");
	}
</script>

<div class="fixed inset-0 z-50 flex flex-col bg-background">
	<div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
		<span class="shrink-0 text-sm font-medium">You have control</span>
		<span class="hidden shrink-0 text-xs text-muted-foreground sm:inline">· the agent's browser is paused</span>
		<input class="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" placeholder="Steer text for the agent (optional)" bind:value={steer} onkeydown={(e) => e.key === "Enter" && handBack()} />
		<Button size="sm" disabled={busy} onclick={handBack}>Hand back</Button>
	</div>
	<iframe title="desktop" src={`/takeover/${box}`} class="min-h-0 w-full flex-1 border-0" allow="clipboard-read *; clipboard-write *; autoplay *; fullscreen *; gamepad *" referrerpolicy="no-referrer"></iframe>
</div>
