<script lang="ts">
	import { onDestroy } from "svelte";
	import Header from "$lib/Header.svelte";
	import { Session, type Line, type State } from "$lib/realtime";

	let state = $state<State>("idle");
	let lines = $state<Line[]>([]);
	let partials = $state<Record<string, { who: "you" | "voice"; text: string }>>({});
	let typed = $state("");
	let canvas: HTMLCanvasElement, audio: HTMLAudioElement, scroller = $state<HTMLElement>();
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
	};

	async function toggle() {
		if (session && state !== "idle" && state !== "error") { session.stop(); session = undefined; return; }
		session = new Session(hooks, audio);
		(window as unknown as { __voice: Session }).__voice = session; // for headless tests
		try { await session.start(); } catch { session = undefined; }
	}

	// The orb: soft layered blobs. Spins slowly while listening (breathing with the mic), bounces with the voice's audio.
	let raf = 0, t = 0, smooth = 0;
	function draw() {
		raf = requestAnimationFrame(draw);
		if (!canvas) return;
		const dpr = window.devicePixelRatio || 1, size = canvas.clientWidth;
		if (canvas.width !== size * dpr) { canvas.width = canvas.height = size * dpr; }
		const g = canvas.getContext("2d")!;
		const W = canvas.width, c = W / 2;
		const live = state !== "idle" && state !== "error";
		const lvl = session ? (state === "speaking" ? session.level("out") : session.level("in") * 0.5) : 0;
		smooth += (lvl - smooth) * 0.25;
		const speed = state === "thinking" ? 0.05 : state === "speaking" ? 0.02 : live ? 0.012 : 0.004;
		t += speed;
		g.clearRect(0, 0, W, W);
		const base = W * 0.3 * (1 + smooth * 0.35 + (state === "thinking" ? Math.sin(t * 3) * 0.03 : 0));
		const hues = state === "error" ? [0, 10, 350] : state === "thinking" ? [265, 285, 230] : [210, 250, 190];
		g.globalCompositeOperation = "lighter";
		for (let k = 0; k < 3; k++) {
			const a = t * (1 + k * 0.4) + (k * Math.PI * 2) / 3;
			const off = W * 0.05 * (1 + smooth);
			const x = c + Math.cos(a) * off, y = c + Math.sin(a) * off;
			const r = base * (0.9 + 0.1 * Math.sin(t * 2 + k));
			const grad = g.createRadialGradient(x, y, r * 0.1, x, y, r);
			grad.addColorStop(0, `hsla(${hues[k]},90%,70%,${live ? 0.85 : 0.45})`);
			grad.addColorStop(0.6, `hsla(${hues[k]},85%,55%,${live ? 0.35 : 0.15})`);
			grad.addColorStop(1, `hsla(${hues[k]},80%,40%,0)`);
			g.fillStyle = grad;
			g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
		}
		g.globalCompositeOperation = "source-over";
	}
	raf = requestAnimationFrame(draw);
	onDestroy(() => { cancelAnimationFrame(raf); session?.stop(); });

	const label = $derived({ idle: "Tap to talk", connecting: "Connecting…", listening: "Listening", thinking: "Asking raubot…", speaking: "Speaking", error: "Error, tap to retry" }[state]);
	function sendTyped(e: Event) { e.preventDefault(); if (typed.trim() && session) { session.say(typed.trim()); typed = ""; } }
</script>

<div class="flex h-dvh flex-col bg-background text-foreground">
	<Header title="voice" href="/" />
	<audio bind:this={audio} autoplay playsinline class="hidden"></audio>
	<div class="flex flex-col items-center gap-3 pt-6">
		<button onclick={toggle} aria-label={label} class="relative size-64 max-w-[70vw] max-h-[70vw] rounded-full outline-none [-webkit-tap-highlight-color:transparent]">
			<canvas bind:this={canvas} class="size-full"></canvas>
		</button>
		<div class="text-sm text-muted-foreground" data-state={state} id="voice-state">{label}</div>
		{#if state === "speaking"}<button class="text-xs text-muted-foreground underline" onclick={() => session?.interrupt()}>interrupt</button>{/if}
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
</div>
