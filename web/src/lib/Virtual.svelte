<script lang="ts" generics="T">
	import { tick, type Snippet } from "svelte";

	/**
	 * Renders only the rows near `scroller`'s viewport (t3code's timeline): heights are measured as rows render and
	 * estimated before. While the reader is at the bottom it stays pinned there; a row resizing above the viewport
	 * doesn't move what they are reading.
	 */
	let { items, key, row, scroller, stuck = $bindable(true), estimate = 80 }: {
		items: T[]; key: (x: T, k: number) => string | number; row: Snippet<[T, number]>; scroller?: HTMLElement; stuck?: boolean; estimate?: number;
	} = $props();

	const OVER = 1500;
	const sizes = new Map<string, number>();
	let list: HTMLElement, version = $state(0), top = $state(0), height = $state(1000);

	const offsets = $derived.by(() => {
		void version;
		const o = [0];
		for (let k = 0; k < items.length; k++) o.push(o[k] + (sizes.get(String(key(items[k], k))) ?? estimate));
		return o;
	});
	const range = $derived.by(() => {
		const lo = top - OVER, hi = top + height + OVER;
		let a = 0;
		while (a < items.length && offsets[a + 1] < lo) a++;
		let b = a;
		while (b < items.length && offsets[b] < hi) b++;
		return [a, b] as const;
	});

	const bottom = () => { if (scroller) scroller.scrollTop = scroller.scrollHeight; };
	function onscroll() {
		if (!scroller || !list) return;
		top = scroller.scrollTop - list.offsetTop;
		height = scroller.clientHeight;
		stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
	}
	$effect(() => {
		if (!scroller) return;
		const s = scroller, ro = new ResizeObserver(() => { onscroll(); if (stuck) bottom(); });
		s.addEventListener("scroll", onscroll, { passive: true });
		ro.observe(s);
		onscroll();
		return () => { s.removeEventListener("scroll", onscroll); ro.disconnect(); };
	});

	const rows = new ResizeObserver((entries) => {
		let shift = 0, changed = false;
		for (const e of entries) {
			const el = e.target as HTMLElement, id = el.dataset.key!, at = Number(el.dataset.index);
			const h = e.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight, old = sizes.get(id) ?? estimate;
			if (!el.isConnected || h === old) continue;
			sizes.set(id, h);
			changed = true;
			if ((offsets[at] ?? 0) + old <= top) shift += h - old;
		}
		if (!changed) return;
		version++;
		if (stuck) void tick().then(bottom);
		else if (shift && scroller) scroller.scrollTop += shift;
	});
	const measure = (el: HTMLElement) => { rows.observe(el); return { destroy: () => rows.unobserve(el) }; };
</script>

<div bind:this={list}>
	<div style:height="{offsets[range[0]]}px"></div>
	{#each items.slice(range[0], range[1]) as x, j (key(x, range[0] + j))}
		<div use:measure data-key={key(x, range[0] + j)} data-index={range[0] + j} class="flex flex-col pb-4">{@render row(x, range[0] + j)}</div>
	{/each}
	<div style:height="{offsets[items.length] - offsets[range[1]]}px"></div>
</div>
