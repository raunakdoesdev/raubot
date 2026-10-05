<script lang="ts">
	import { tick } from "svelte";
	import { ArrowUp, ChevronRight, Paperclip, Settings, Square, X } from "@lucide/svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import * as Collapsible from "$lib/components/ui/collapsible";
	import Header from "$lib/Header.svelte";
	import SecretForm from "$lib/SecretForm.svelte";
	import { md } from "$lib/md";

	type Line = { i: number; kind: string; text: string };
	type Tool = { kind: "tool"; i: number; name: string; head: string; body: string };
	type Item = { kind: "user" | "talk"; i: number; text: string } | Tool;
	type Ask = { token: string; name: string; why: string };

	let items = $state<Item[]>([]), asks = $state<Ask[]>([]), queued = $state<string[]>([]);
	let partial = $state(""), busy = $state(false), summarizing = $state(false), note = $state("");
	let text = $state(""), files = $state<string[]>([]), uploading = $state(0);
	let main: HTMLElement, box: HTMLTextAreaElement, picker: HTMLInputElement, ws: WebSocket;
	let open: { name: string; at: number }[] = [];

	const strip = (s: string) => s.replace(/^\[(via \w+|iMessage)\] /, "");
	const canSend = $derived(!uploading && (text.trim().length > 0 || files.length > 0));
	const status = $derived(note || [busy && "thinking…", summarizing && "summarizing"].filter(Boolean).join(" · "));

	/** Folds a log line in: a tool call and its echo become one collapsible row. */
	function add(x: Line) {
		if (x.kind === "job") {
			const t = strip(x.text);
			items.push({ kind: "tool", i: x.i, name: "job", head: t.split("\n")[0], body: t });
		} else if (x.kind === "tool" || x.kind === "echo") {
			const name = x.text.split(/[\s:]/)[0], result = `→ ${x.text.slice(name.length + 1).trim().split("\n")[0]}`;
			const j = x.kind === "echo" ? open.findIndex((o) => o.name === name) : -1;
			if (j >= 0) {
				const t = items[open.splice(j, 1)[0].at] as Tool;
				t.head = result; t.body += `\n\n${x.text}`;
				return;
			}
			items.push({ kind: "tool", i: x.i, name, head: x.kind === "echo" ? result : "", body: x.text });
			if (x.kind === "tool") open.push({ name, at: items.length - 1 });
		} else {
			open = [];
			items.push({ kind: x.kind === "user" ? "user" : "talk", i: x.i, text: x.kind === "user" ? strip(x.text) : x.text });
		}
	}

	const near = () => !main || main.scrollHeight - main.scrollTop - main.clientHeight < 120;
	const down = async (force = false) => { if (force || near()) { await tick(); main.scrollTop = main.scrollHeight; } };

	function connect() {
		ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
		ws.onmessage = (e) => {
			const m = JSON.parse(e.data), stick = near();
			if (m.asks) asks = m.asks;
			if (m.queued) queued = m.queued;
			if (m.history) { for (const x of m.history) add(x); partial = ""; }
			if (m.partial !== undefined) partial = m.partial;
			if (m.busy !== undefined) { busy = m.busy; summarizing = !!m.pending; note = ""; }
			if (m.status) note = m.status;
			if (m.error) note = m.error;
			if (stick) down(true);
		};
		ws.onclose = () => setTimeout(() => { items = []; open = []; connect(); }, 1000);
	}
	connect();

	const fit = () => { box.style.height = "auto"; box.style.height = `${box.scrollHeight}px`; };
	function send() {
		if (!canSend) return;
		ws.send(JSON.stringify({ send: text.trim(), files }));
		text = ""; files = [];
		tick().then(fit);
		down(true);
	}
	async function pick() {
		const picked = [...(picker.files ?? [])];
		picker.value = ""; uploading += picked.length;
		await Promise.all(picked.map(async (f) => {
			const fd = new FormData(); fd.append("file", f);
			const r = await fetch("/upload", { method: "POST", body: fd });
			if (r.ok) files.push((await r.json()).path); else note = `upload failed: ${await r.text()}`;
			uploading--;
		}));
	}
	const key = (e: KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); send(); }
	};
</script>

<div class="flex h-dvh flex-col overflow-hidden">
	<Header>
		<span class="truncate text-sm text-muted-foreground">{status}</span>
		<Button href="/settings" variant="ghost" size="icon-sm" aria-label="settings"><Settings /></Button>
	</Header>

	<main bind:this={main} class="no-scrollbar flex-1 overflow-y-auto overscroll-contain">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
			{#each items as x (x.i)}
				{#if x.kind === "user"}
					<div class="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 whitespace-pre-wrap [overflow-wrap:anywhere]" title="#{x.i}">{x.text}</div>
				{:else if x.kind === "talk"}
					<div class="md" title="#{x.i}">{@html md(x.text)}</div>
				{:else}
					<Collapsible.Root class="-my-2">
						<Collapsible.Trigger class="group flex w-full min-w-0 items-center gap-1.5 py-1 text-left font-mono text-xs text-muted-foreground hover:text-foreground">
							<ChevronRight class="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
							<span class="shrink-0 text-foreground/70">{x.name}</span>
							<span class="truncate">{x.head}</span>
						</Collapsible.Trigger>
						<Collapsible.Content>
							<pre class="mt-1.5 max-h-[50vh] overflow-auto rounded-lg border bg-card p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{x.body}</pre>
						</Collapsible.Content>
					</Collapsible.Root>
				{/if}
			{/each}
			{#each queued as q, k (k)}<div class="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 whitespace-pre-wrap opacity-60 [overflow-wrap:anywhere]">{strip(q)}</div>{/each}
			{#if partial}<div class="md text-foreground/80">{@html md(partial)}</div>{/if}
			{#each asks as a (a.token)}<SecretForm {...a} />{/each}
		</div>
	</main>

	<form onsubmit={(e) => { e.preventDefault(); send(); }} class="mx-auto w-full max-w-3xl shrink-0 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
		<div class="rounded-2xl border bg-card p-2 shadow-sm transition-shadow focus-within:ring-[3px] focus-within:ring-ring/30">
			{#if files.length || uploading}
				<div class="flex flex-wrap gap-1.5 px-1 pt-1 pb-2">
					{#each files as f, k (f)}
						<Badge variant="secondary" class="gap-1 font-normal">{f.split("/").pop()?.replace(/^[a-z0-9]+-/, "")}
							<button type="button" aria-label="remove" onclick={() => files.splice(k, 1)}><X class="size-3" /></button></Badge>
					{/each}
					{#if uploading}<Badge variant="outline" class="font-normal text-muted-foreground">uploading {uploading}…</Badge>{/if}
				</div>
			{/if}
			<textarea bind:this={box} bind:value={text} oninput={fit} onkeydown={key} rows="1" placeholder="Message raubot" enterkeyhint="send" autocomplete="off"
				class="block max-h-[38dvh] w-full resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground"></textarea>
			<div class="flex items-center gap-1">
				<Button type="button" variant="ghost" size="icon-sm" class="rounded-full text-muted-foreground" aria-label="attach" onclick={() => picker.click()}><Paperclip /></Button>
				<div class="flex-1"></div>
				{#if busy}<Button type="button" variant="secondary" size="icon-sm" class="rounded-full" aria-label="stop" onclick={() => ws.send(JSON.stringify({ stop: true }))}><Square class="size-3 fill-current" /></Button>{/if}
				<Button type="submit" size="icon-sm" class="rounded-full" aria-label="send" disabled={!canSend}><ArrowUp /></Button>
			</div>
		</div>
		<input bind:this={picker} type="file" multiple hidden onchange={pick} />
	</form>
</div>
