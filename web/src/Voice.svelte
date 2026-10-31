<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import Header from "$lib/Header.svelte";
	import { Session, type Debug, type Line, type State } from "$lib/realtime";
	import { mountOrb } from "$lib/orb";

	let state = $state<State>("idle");
	let lines = $state<Line[]>([]);
	let partials = $state<Record<string, { who: "you" | "voice"; text: string }>>({});
	let typed = $state("");
	let orbEl: HTMLElement, audio: HTMLAudioElement, scroller = $state<HTMLElement>();
	let debug = $state<Debug | undefined>();
	let session: Session | undefined;

	const hooks = {
		state: (s: State) => (state = s),
		line: (l: Line) => {
			if (!l.text) return;
			if (l.id) delete partials[l.id];
			lines.push(l);
			queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }));
		},
		partial: (who: "you" | "voice", id: string, t: string) => { partials[id] = { who, text: (partials[id]?.text ?? "") + t }; },
		debug: (d: Debug) => (debug = d),
	};

	async function toggle() {
		if (session && state !== "idle" && state !== "error") { session.stop(); session = undefined; return; }
		session = new Session(hooks, audio);
		(window as unknown as { __voice: Session }).__voice = session; // for headless tests
		try { await session.start(); } catch { session = undefined; }
	}

	// The orb: orb-ui (React, controlled mode), driven by our session state and separate mic / speaker levels.
	// Levels are pushed ~30fps; orb-ui shows input volume while listening and output volume while speaking.
	let orb: ReturnType<typeof mountOrb> | undefined, raf = 0, last = 0;
	const orbSize = () => Math.min(256, Math.round(window.innerWidth * 0.7));
	function tick(now: number) {
		raf = requestAnimationFrame(tick);
		if (!orb || now - last < 33) return;
		last = now;
		orb.render({
			signal: { state, inputVolume: session?.level("in") ?? 0, outputVolume: session?.level("out") ?? 0 },
			size: orbSize(), label,
			onStart: () => void toggle(), onStop: () => void toggle(),
		});
	}
	onMount(() => { orb = mountOrb(orbEl); raf = requestAnimationFrame(tick); });
	onDestroy(() => { cancelAnimationFrame(raf); orb?.destroy(); session?.stop(); });

	const label = $derived({ idle: "Tap to talk", connecting: "Connecting…", listening: "Listening", thinking: "Asking raubot…", speaking: "Speaking", error: "Error, tap to retry" }[state]);
	function sendTyped(e: Event) { e.preventDefault(); if (typed.trim() && session) { session.say(typed.trim()); typed = ""; } }
</script>

<div class="flex h-dvh flex-col bg-background text-foreground">
	<Header title="voice" href="/" />
	<audio bind:this={audio} autoplay playsinline class="hidden"></audio>
	<div class="flex flex-col items-center gap-3 pt-6">
		<div bind:this={orbEl} class="flex size-64 max-h-[70vw] max-w-[70vw] items-center justify-center [-webkit-tap-highlight-color:transparent]"></div>
		<div class="text-sm text-muted-foreground" data-state={state} id="voice-state">{label}</div>
		{#if state === "speaking"}<button class="text-xs text-muted-foreground underline" onclick={() => session?.interrupt()}>interrupt</button>{/if}
		{#if session && state !== "idle" && state !== "error"}<button class="rounded-full border border-red-500/50 px-4 py-1 text-xs text-red-400" onclick={toggle} id="voice-end">End call</button>{/if}
	</div>
	<div bind:this={scroller} class="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-4 py-4 text-sm" id="voice-log">
		{#each lines as l, i (i)}
			{#if l.who === "sys"}
				<details class="my-1 text-xs text-violet-400/80"><summary class="cursor-pointer truncate">{l.text}</summary><div class="whitespace-pre-wrap">{l.text}</div></details>
			{:else if l.who === "raubot"}
				<details class="my-1 rounded-lg border border-violet-500/30 px-3 py-2 text-xs"><summary class="cursor-pointer text-violet-400">raubot replied</summary><div class="mt-1 whitespace-pre-wrap text-muted-foreground">{l.text}</div></details>
			{:else}
				<div class={["my-2 max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2", l.who === "you" ? "ml-auto bg-secondary" : "bg-muted/40"]}>{l.text}</div>
			{/if}
		{/each}
		{#each Object.entries(partials) as [id, p] (id)}
			<div class={["my-2 max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 opacity-60", p.who === "you" ? "ml-auto bg-secondary" : "bg-muted/40"]}>{p.text}</div>
		{/each}
	</div>
	{#if session && state !== "idle"}
		<form onsubmit={sendTyped} class="mx-auto flex w-full max-w-2xl gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
			<input bind:value={typed} placeholder="or type…" class="flex-1 rounded-full border bg-transparent px-4 py-2 text-base outline-none" />
		</form>
	{/if}
	{#if debug}
		<details class="mx-auto w-full max-w-2xl px-4 pb-2 text-[11px] text-muted-foreground" id="voice-debug">
			<summary class="cursor-pointer">mic debug: getUserMedia ×{debug.getUserMedia} · tracks {debug.tracks} · {debug.trackState} · {debug.model}</summary>
			<div>route: {debug.route} · audioSession: {debug.audioSession}</div>
			<pre class="max-h-48 overflow-y-auto whitespace-pre-wrap">{debug.events.join("\n")}</pre>
		</details>
	{/if}
</div>
