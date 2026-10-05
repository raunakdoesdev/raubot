<script lang="ts">
	import { onDestroy, tick } from "svelte";
	import { ArrowUp, ChevronRight, PanelLeft } from "@lucide/svelte";
	import { Button } from "$lib/components/ui/button";
	import * as Collapsible from "$lib/components/ui/collapsible";
	import Header from "$lib/Header.svelte";
	import { md } from "$lib/md";
	import ToolRow from "$lib/ToolRow.svelte";
	import { fnv, summary, traces } from "$lib/traces.svelte";

	type Line = { role: "user" | "assistant" | "tool" | "result"; text: string; name?: string };
	type Agent = { id: number; task: string; computer: boolean; status: "running" | "idle"; started: string; last: string };

	let { id, onmenu }: { id: number; onmenu: () => void } = $props();
	let agent = $state<Agent>(), lines = $state<Line[]>([]), note = $state(""), text = $state(""), sending = $state(false);
	let main: HTMLElement, box: HTMLTextAreaElement, first = true;

	const near = () => !main || main.scrollHeight - main.scrollTop - main.clientHeight < 120;
	async function poll() {
		try {
			const r = await fetch(`/agent.json?id=${id}`);
			if (!r.ok) throw new Error(await r.text());
			const d = await r.json(), stick = first || near();
			agent = d.agent;
			if (d.lines.length !== lines.length || JSON.stringify(d.lines.at(-1)) !== JSON.stringify(lines.at(-1))) lines = d.lines;
			if (stick) { await tick(); main.scrollTop = main.scrollHeight; }
			first = false;
		} catch (e) { note = String(e).slice(0, 160); }
	}
	// Its traced script runs (polled; only raubot's own stream over the socket). Tool rows match them by code hash, newest back.
	const scope = `agent:${id}`;
	const pollTraces = () => fetch(`/traces.json?conv=${id}`).then((r) => (r.ok ? r.json() : [])).then((l) => traces.merge(l, scope)).catch(() => {});
	const codeOf = (x: Line) => (x.role === "tool" && x.name === "codemode" ? x.text : "");
	const runFor = $derived(traces.matchTail(lines.flatMap((x, k) => (codeOf(x) ? [{ key: k, hash: fnv(x.text) }] : [])), scope));
	const echoAfter = (k: number) => (lines[k + 1]?.role === "result" ? lines[k + 1].text : "");
	pollTraces();
	const ttimer = setInterval(() => { if (!document.hidden) pollTraces(); }, 3000);
	onDestroy(() => clearInterval(ttimer));
	poll();
	const timer = setInterval(() => { if (!document.hidden) poll(); }, 3000);
	onDestroy(() => clearInterval(timer));

	const fit = () => { box.style.height = "auto"; box.style.height = `${box.scrollHeight}px`; };
	async function send() {
		const message = text.trim();
		if (!message || sending) return;
		sending = true; note = "";
		try {
			const r = await fetch(`/agent.json?id=${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
			if (!r.ok) throw new Error(await r.text());
			const { ok } = await r.json();
			note = ok === "steered" ? "sent; it reads it at its next step" : "sent; waiting for its reply…";
			text = ""; await tick(); fit();
			setTimeout(poll, 800);
		} catch (e) { note = `send failed: ${String(e).slice(0, 160)}`; }
		sending = false;
	}
	const key = (e: KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); send(); }
	};
	$effect(() => { if (agent?.status === "idle" && note.startsWith("sent")) note = ""; });
</script>

<div class="flex h-dvh min-w-0 flex-1 flex-col overflow-hidden">
	<Header title={`subagent #${id}`}>
		{#snippet lead()}<Button variant="ghost" size="icon-sm" class="md:hidden" aria-label="menu" onclick={onmenu}><PanelLeft /></Button>{/snippet}
		<span class="truncate text-sm text-muted-foreground">{note || (agent ? `${agent.status}${agent.computer ? " · computer" : ""}` : "loading…")}</span>
	</Header>

	<main bind:this={main} class="no-scrollbar flex-1 overflow-y-auto overscroll-contain">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
			{#each lines as x, k (k)}
				{#if x.role === "user"}
					<Collapsible.Root open={k > 0 || x.text.length < 600}>
						<Collapsible.Trigger class="group ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
							<ChevronRight class="size-3.5 transition-transform group-data-[state=open]:rotate-90" />{k === 0 ? "task" : "message"}
						</Collapsible.Trigger>
						<Collapsible.Content>
							<div class="mt-1 ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{x.text}</div>
						</Collapsible.Content>
					</Collapsible.Root>
				{:else if x.role === "assistant"}
					<div class="md">{@html md(x.text)}</div>
				{:else if x.role === "tool"}
					{#if codeOf(x)}<ToolRow name="codemode" arg={summary(x.text)} code={x.text} echo={echoAfter(k)} run={runFor.get(k)} live={false} />
					{:else}<ToolRow name={x.name ?? "tool"} arg={x.text.split("\n")[0]} body={x.text} echo={echoAfter(k)} />{/if}
				{:else if lines[k - 1]?.role !== "tool"}
					<ToolRow name={"→ " + (x.name ?? "")} arg={x.text.split("\n")[0]} echo={x.text} />
				{/if}
			{/each}
			{#if agent?.status === "running"}<div class="text-sm text-muted-foreground">working…</div>{/if}
		</div>
	</main>

	<form onsubmit={(e) => { e.preventDefault(); send(); }} class="mx-auto w-full max-w-3xl shrink-0 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
		<div class="flex items-end gap-1 rounded-2xl border bg-card p-2 shadow-sm focus-within:ring-[3px] focus-within:ring-ring/30">
			<textarea bind:this={box} bind:value={text} oninput={fit} onkeydown={key} rows="1" placeholder={agent?.status === "running" ? "Steer this subagent" : "Ask this subagent a follow-up"} enterkeyhint="send" autocomplete="off"
				class="block max-h-[38dvh] w-full resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground"></textarea>
			<Button type="submit" size="icon-sm" class="rounded-full" aria-label="send" disabled={!text.trim() || sending}><ArrowUp /></Button>
		</div>
	</form>
</div>
