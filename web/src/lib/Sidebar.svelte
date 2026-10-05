<script lang="ts">
	import { onDestroy } from "svelte";
	import { Bot, Clock, MessageSquare, Monitor, Search } from "@lucide/svelte";
	import Palette from "$lib/Palette.svelte";

	type AgentRow = { id: number; task: string; computer: boolean; status: "running" | "idle"; started: string; last: string };
	type JobRow = { id: number; label: string; status: string; started: string; ended?: string };

	let { selected = $bindable(0), open = $bindable(false) }: { selected?: number; open?: boolean } = $props();
	let agents = $state<AgentRow[]>([]), jobs = $state<JobRow[]>([]), err = $state("");

	/** A short title: the task's first line, without the "Task:" boilerplate. */
	const title = (t: string) => t.replace(/^\s*(task:\s*)?/i, "").split("\n")[0].slice(0, 80);
	const ago = (iso: string) => {
		const s = (Date.now() - Date.parse(iso)) / 1000;
		return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
	};

	/** Keeps the last good list on failure; the error is a short line, never a server's HTML page. */
	async function poll() {
		try {
			const r = await fetch("/agents.json");
			if (!r.ok) { err = `couldn't load subagents (HTTP ${r.status}), retrying`; return; }
			const d = await r.json().catch(() => undefined);
			if (!d || !Array.isArray(d.agents)) { err = "couldn't load subagents, retrying"; return; }
			agents = d.agents; jobs = Array.isArray(d.jobs) ? d.jobs : jobs; err = "";
		} catch { err = "offline, retrying"; }
	}
	poll();
	const timer = setInterval(() => { if (!document.hidden) poll(); }, 4000);
	onDestroy(() => clearInterval(timer));

	const pick = (id: number) => { selected = id; open = false; };
	let searching = $state(false), extra = $state<AgentRow>();
	const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
	/** Active subagents only; one picked from search stays listed while it's open. */
	const active = $derived.by(() => {
		const on = agents.filter((a) => a.status === "running");
		const cur = agents.find((a) => a.id === selected) ?? (extra?.id === selected ? extra : undefined);
		return cur && !on.some((a) => a.id === cur.id) ? [...on, cur] : on;
	});
	/** Picked from search: may be older than the 20 newest the list polls. */
	async function found(id: number) {
		pick(id);
		if (!agents.some((a) => a.id === id)) {
			const r = await fetch(`/agent.json?id=${id}`).catch(() => undefined);
			if (r?.ok) extra = (await r.json()).agent;
		}
	}
	const hotkey = (e: KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); searching = !searching; }
	};
	const running = $derived(jobs.filter((j) => j.status === "running"));
	const recent = $derived(jobs.filter((j) => j.status !== "running").slice(0, 8));
</script>

<svelte:window onkeydown={hotkey} />
<Palette bind:open={searching} onpick={found} />
{#if open}<button class="fixed inset-0 z-30 bg-black/50 md:hidden" aria-label="close sidebar" onclick={() => (open = false)}></button>{/if}
<aside class="fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r bg-background pt-[env(safe-area-inset-top)] transition-transform md:static md:translate-x-0 {open ? 'translate-x-0' : '-translate-x-full'}">
	<div class="no-scrollbar flex-1 overflow-y-auto p-2 text-sm">
		<button class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-accent {selected === 0 ? 'bg-accent font-medium' : ''}" onclick={() => pick(0)}>
			<MessageSquare class="size-4 shrink-0" /> raubot
		</button>

		<div class="mt-4 mb-1 flex items-center px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
			<span>Active subagents</span>
			<button class="ml-auto flex items-center gap-1 rounded px-1 py-0.5 normal-case tracking-normal hover:bg-accent hover:text-foreground" title="Search all subagents" onclick={() => { searching = true; open = false; }}>
				<Search class="size-3" /><kbd class="font-sans">{mac ? "⌘" : "Ctrl "}K</kbd>
			</button>
		</div>
		{#each active as a (a.id)}
			<button class="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-accent {selected === a.id ? 'bg-accent' : ''}" onclick={() => pick(a.id)} title={a.task}>
				<span class="flex w-full min-w-0 items-center gap-2">
					<span class="size-2 shrink-0 rounded-full {a.status === 'running' ? 'animate-pulse bg-emerald-400' : 'bg-muted-foreground/40'}"></span>
					<span class="truncate">{title(a.task)}</span>
				</span>
				<span class="flex items-center gap-1.5 pl-4 text-xs text-muted-foreground">
					{#if a.computer}<Monitor class="size-3" />{:else}<Bot class="size-3" />{/if}
					#{a.id} · {a.status} · {ago(a.started)}
				</span>
			</button>
		{:else}
			<button class="w-full px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground" onclick={() => { searching = true; open = false; }}>none running · {mac ? "⌘" : "Ctrl+"}K to search all</button>
		{/each}

		{#if jobs.length}
			<div class="mt-4 mb-1 px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">Jobs</div>
			{#each [...running, ...recent] as j (j.id)}
				<div class="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground" title="{j.label} ({j.status})">
					<Clock class="size-3 shrink-0 {j.status === 'running' ? 'text-emerald-400' : ''}" />
					<span class="truncate">{j.label}</span>
					<span class="ml-auto shrink-0">{j.status === "running" ? ago(j.started) : j.status}</span>
				</div>
			{/each}
		{/if}
		{#if err}<div class="px-3 py-2 text-xs text-destructive">{err}</div>{/if}
	</div>
</aside>
