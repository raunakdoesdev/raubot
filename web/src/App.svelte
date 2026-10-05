<script lang="ts">
	import { tick } from "svelte";
	import { ArrowDown, ArrowUp, ChevronRight, PanelLeft, Paperclip, Settings, Square, X } from "@lucide/svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import ToolRow from "$lib/ToolRow.svelte";
	import { parseTool, traces } from "$lib/traces.svelte";
	import Header from "$lib/Header.svelte";
	import SecretForm from "$lib/SecretForm.svelte";
	import Sidebar from "$lib/Sidebar.svelte";
	import AgentView from "$lib/AgentView.svelte";
	import FilePanel from "$lib/FilePanel.svelte";
	import { linkPaths, md, mdLive } from "$lib/md";
	import Virtual from "$lib/Virtual.svelte";
	const plain = (s: string) => linkPaths(s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));

	type Line = { i: number; kind: string; text: string; date?: number };
	/** `body` is the call line; `echo` its result; codemode rows carry their `code` and `hash` (matched to a live trace), job rows their `job` id. */
	type Tool = { kind: "tool"; i: number; name: string; head: string; body: string; arg?: string; code?: string; hash?: string; echo?: string; date?: number; job?: number };
	type Item = { kind: "user" | "talk"; i: number; text: string } | Tool;
	type Ask = { token: string; name: string; why: string };

	/** A message shown the moment it's sent, until the server echoes it back queued, steering or in the log (t3code's optimistic send). */
	type Local = { id: number; text: string; files: string[]; full: string; intent: "steer" | "queued"; sent: boolean };

	let items = $state<Item[]>([]), asks = $state<Ask[]>([]), queued = $state<string[]>([]), steering = $state<string[]>([]), local = $state<Local[]>([]);
	let stuck = $state(true), seq = 0, seen = -1; // last log line folded in; echoes merge into rows, so items.at(-1) can lag
	let partial = $state(""), busy = $state(false), summarizing = $state(false), note = $state("");
	let text = $state(""), files = $state<string[]>([]), uploading = $state(0);
	let main = $state<HTMLElement>(), box: HTMLTextAreaElement, picker: HTMLInputElement, ws: WebSocket;
	let open: { name: string; at: number }[] = [];
	let selected = $state(0), menu = $state(false);

	const strip = (s: string) => s.replace(/^\[(via \w+|iMessage)\] /, "");
	/** Signed Devin callbacks: their own row, whatever kind older logs gave them. */
	const isDevin = (s: string) => /^\[devin [\w-]+ /.test(strip(s));
	/** System inputs (jobs, crons, secrets, Devin) waiting in the inbox: not user bubbles. */
	const isSystem = (s: string) => /^\[(job \d+|secret \w+|cron [\w-]+|devin [\w-]+)[\] ]/.test(strip(s));
	const canSend = $derived(!uploading && (text.trim().length > 0 || files.length > 0));
	const status = $derived(note || [busy && "thinking…", summarizing && "summarizing"].filter(Boolean).join(" · "));

	/** Folds a log line in: a tool call and its echo become one collapsible row. */
	function add(x: Line) {
		if (x.kind === "devin" || ((x.kind === "job" || x.kind === "user") && isDevin(x.text))) {
			return; // Devin callbacks: stored and delivered to the agent, never shown (Raunak's call).
		} else if (x.kind === "job") {
			const t = strip(x.text);
			const head = t.split("\n")[0], job = Number(/\[job (\d+)/.exec(head)?.[1]);
			items.push({ kind: "tool", i: x.i, name: "job", head, body: "", arg: head, echo: t, job: Number.isFinite(job) ? job : undefined });
		} else if (x.kind === "tool" || x.kind === "echo") {
			const name = x.text.split(/[\s:]/)[0], result = `→ ${x.text.slice(name.length + 1).trim().split("\n")[0]}`;
			const j = x.kind === "echo" ? open.findIndex((o) => o.name === name) : -1;
			if (j >= 0) {
				const t = items[open.splice(j, 1)[0].at] as Tool;
				t.head = result; t.echo = x.text.slice(name.length + 2);
				return;
			}
			const p = x.kind === "tool" ? parseTool(x.text) : undefined;
			items.push({ kind: "tool", i: x.i, name, head: x.kind === "echo" ? result : "", body: x.kind === "tool" ? x.text : "", echo: x.kind === "echo" ? x.text.slice(name.length + 2) : "", arg: p?.arg ?? result, code: p?.code, hash: p?.hash, date: x.date });
			if (x.kind === "tool") open.push({ name, at: items.length - 1 });
		} else {
			open = [];
			items.push({ kind: x.kind === "user" ? "user" : "talk", i: x.i, text: x.kind === "user" ? strip(x.text) : x.text });
		}
	}

	// Tool rows -> their traced runs (by code hash, nearest start after the row's time).
	const runFor = $derived(traces.match(items.flatMap((x) => (x.kind === "tool" && x.hash ? [{ key: x.i, hash: x.hash, date: x.date ?? 0 }] : [])), "main"));
	const loadTraces = () => fetch("/traces.json").then((r) => (r.ok ? r.json() : [])).then((l) => traces.merge(l, "main")).catch(() => {});

	const near = () => !main || main.scrollHeight - main.scrollTop - main.clientHeight < 120;
	const down = async (force = false) => { if (force || near()) { await tick(); if (main) main.scrollTop = main.scrollHeight; } };

	function connect() {
		ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
		ws.onmessage = (e) => {
			const m = JSON.parse(e.data), stick = near();
			if (m.trace) traces.apply(m.trace);
			if (m.asks) asks = m.asks;
			if (m.queued) queued = m.queued;
			if (m.steering) steering = m.steering;
			if (m.history) {
				// A reconnect's snapshot: keep what's drawn and add only newer lines, unless there's a gap.
				if (m.history[0]?.i > seen + 1) { items = []; open = []; }
				for (const x of m.history) if (x.i > seen) { add(x); seen = x.i; }
				live(""); 
			}
			if (m.partial !== undefined) live(m.partial);
			const echoed = [...(m.queued ?? []), ...(m.steering ?? []), ...(m.history ?? []).filter((x: Line) => x.kind === "user").map((x: Line) => x.text)];
			if (echoed.length) local = local.filter((l) => !l.sent || !echoed.some((t) => t.includes(l.full)));
			if (m.busy !== undefined) { busy = m.busy; summarizing = !!m.pending; note = ""; }
			if (m.status) note = m.status;
			if (m.error) note = m.error;
			if (stick) down(true);
		};
		ws.onopen = () => { loadTraces(); for (const l of local) if (!l.sent) flush(l); };
		ws.onclose = () => setTimeout(connect, 1000);
	}
	connect();

	const fit = () => { box.style.height = "auto"; box.style.height = `${box.scrollHeight}px`; };
	// Streamed text lands at most once a frame.
	let next = "", frame = 0;
	function live(p: string) {
		next = p;
		if (!p) { cancelAnimationFrame(frame); frame = 0; partial = ""; return; }
		frame ||= requestAnimationFrame(() => { frame = 0; partial = next; if (stuck) down(true); });
	}
	function flush(l: Local) {
		if (ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ send: l.text, files: l.files }));
		l.sent = true;
	}
	function send() {
		if (!canSend) return;
		const t = text.trim(), l = { id: ++seq, text: t, files: [...files], full: [t, ...files.map((f) => `[attached: ${f}]`)].filter(Boolean).join("\n"), intent: busy ? "steer" : "queued", sent: false } satisfies Local;
		local.push(l);
		flush(local.at(-1)!);
		text = ""; files = [];
		tick().then(fit);
		down(true);
	}
	/** Uploads files exactly like the attach button: one POST /upload each, paths added to the draft. */
	async function attach(list: File[]) {
		if (!list.length) return;
		uploading += list.length;
		await Promise.all(list.map(async (f) => {
			try {
				const fd = new FormData(); fd.append("file", f, f.name);
				const r = await fetch("/upload", { method: "POST", body: fd });
				if (r.ok) files.push((await r.json()).path); else note = `upload failed: ${await r.text()}`;
			} catch (e) { note = `upload failed: ${e instanceof Error ? e.message : e}`; }
			finally { uploading--; }
		}));
	}
	function pick() {
		const picked = [...(picker.files ?? [])];
		picker.value = "";
		attach(picked);
	}
	// Drag and drop: a counter (not the event target) tracks enter/leave so child elements don't flicker the overlay.
	let drag = $state(false), depth = 0;
	const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
	function dragenter(e: DragEvent) { if (!hasFiles(e)) return; e.preventDefault(); depth++; drag = true; }
	function dragover(e: DragEvent) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; drag = true; }
	function dragleave(e: DragEvent) { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; drag = false; } }
	function drop(e: DragEvent) {
		depth = 0; drag = false;
		if (!hasFiles(e)) return;
		e.preventDefault();
		attach([...(e.dataTransfer?.files ?? [])]);
	}
	// Stops a file dropped outside the chat from making the browser open it; resets the overlay if a drag ends elsewhere.
	const guard = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); if (e.type === "drop") { depth = 0; drag = false; } } };
	// Pasted images (screenshots etc.) attach; pasted text is left alone.
	function paste(e: ClipboardEvent) {
		const d = e.clipboardData;
		if (!d) return;
		let got = [...d.files];
		if (!got.length) got = [...d.items].filter((x) => x.kind === "file").map((x) => x.getAsFile()).filter((f): f is File => !!f);
		if (!got.length) return;
		e.preventDefault();
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		attach(got.map((f, k) => {
			const ext = (f.type.split("/")[1] || "bin").replace("jpeg", "jpg").replace(/\+.*/, "");
			const generic = !f.name || /^image\.\w+$/i.test(f.name);
			return generic ? new File([f], `pasted-${stamp}${got.length > 1 ? `-${k + 1}` : ""}.${ext}`, { type: f.type }) : f;
		}));
	}
	const key = (e: KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); send(); }
	};
</script>

<svelte:window ondragover={guard} ondrop={guard} />
<div class="flex h-dvh overflow-hidden">
<Sidebar bind:selected bind:open={menu} />
{#if selected}{#key selected}<AgentView id={selected} onmenu={() => (menu = true)} />{/key}{/if}
<div class="relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden" class:hidden={selected !== 0} role="region" aria-label="chat" ondragenter={dragenter} ondragover={dragover} ondragleave={dragleave} ondrop={drop}>
	{#if drag}
		<div class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
			<div class="flex h-full w-full max-w-3xl flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-primary/60 text-muted-foreground">
				<Paperclip class="size-8" />
				<span class="text-base font-medium text-foreground">Drop files to attach</span>
			</div>
		</div>
	{/if}
	<Header>
		{#snippet lead()}<Button variant="ghost" size="icon-sm" class="md:hidden" aria-label="menu" onclick={() => (menu = true)}><PanelLeft /></Button>{/snippet}
		<span class="truncate text-sm text-muted-foreground">{status}</span>
		<Button href="/settings" variant="ghost" size="icon-sm" aria-label="settings"><Settings /></Button>
	</Header>

	<main bind:this={main} class="no-scrollbar flex-1 [overflow-anchor:none] overflow-y-auto overscroll-contain">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
			<Virtual {items} key={(x) => x.i} scroller={main} bind:stuck>
				{#snippet row(x)}
					{#if x.kind === "user"}
						<div class="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 whitespace-pre-wrap [overflow-wrap:anywhere]" title="#{x.i}">{@html plain(x.text)}</div>
					{:else if x.kind === "talk"}
						<div class="md" title="#{x.i}">{@html md(x.text)}</div>
					{:else if x.kind === "tool"}
						<ToolRow name={x.name} arg={x.arg ?? x.head} code={x.code} body={x.code ? "" : x.body} echo={x.echo} run={x.job !== undefined ? traces.byJob(x.job) : runFor.get(x.i)} />
					{/if}
				{/snippet}
			</Virtual>
			{#each [...steering.map((t) => ({ t, intent: "steer" })), ...queued.map((t) => ({ t, intent: "queued" })), ...local.map((l) => ({ t: l.text, intent: l.intent }))] as q, k (k)}
				{#if isDevin(q.t)}
				{:else if isSystem(q.t)}
					<div class="truncate font-mono text-xs text-muted-foreground opacity-70">{strip(q.t).split("\n")[0]} · {q.intent === "steer" ? "joins at the next step" : "queued"}</div>
				{:else}
				<div class="ml-auto flex max-w-[85%] flex-col items-end gap-1">
					<div class="rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 whitespace-pre-wrap opacity-70 [overflow-wrap:anywhere]">{strip(q.t)}</div>
					<span class="text-xs text-muted-foreground">{q.intent === "steer" ? "steer · joins at the next step" : "queued"}</span>
				</div>
				{/if}
			{/each}
			{#if partial}<div class="md text-foreground/80">{@html mdLive(partial)}</div>{/if}
			{#each asks as a (a.token)}<SecretForm {...a} />{/each}
		</div>
	</main>

	{#if !stuck}<div class="relative mx-auto w-full max-w-3xl"><Button variant="secondary" size="sm" class="absolute -top-11 left-1/2 -translate-x-1/2 rounded-full shadow" onclick={() => down(true)}><ArrowDown /> latest</Button></div>{/if}
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
			<textarea bind:this={box} bind:value={text} oninput={fit} onkeydown={key} onpaste={paste} rows="1" placeholder="Message raubot" enterkeyhint="send" autocomplete="off"
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
</div>
<FilePanel />
