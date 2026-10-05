// pi 1.0's codemode, in-process: pi-codemode's host spawns a worker_threads Worker, which workerd lacks,
// so this drives the same QuickJS prelude directly. An interrupt deadline stands in for terminate().
import { JSException, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
import wasm from "quickjs-wasi/quickjs.wasm";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { PRELUDE_SOURCE } from "../../node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js";

/** `call` is the script's call id: stable across a snapshot restore, so a tool can key durable work on it. */
export type Nested = { name: string; description: string; inputSchema: object; execute: (args: never, call: number) => Promise<unknown> };
/** A frozen running script: the VM image plus what the host owed it. */
export type Frozen = { image: Uint8Array; api: number; pending: [number, string, unknown][]; output: string[]; deadline: number };
export type Freezer = { load(): Promise<Frozen | undefined>; save(f: Frozen): Promise<void> };
type Store = Record<string, unknown>;

export const describe = (tools: Nested[]) => `Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, direct file system or network: use tools.read/edit/write/bash for files. \`setTimeout\`/\`clearTimeout\` work.
- \`await tools.<name>({ ...args })\` resolves to the tool's text output and rejects with an Error on failure.
- \`text(value)\`, \`console.log(...)\` and \`return\` add output. \`image(dataUrlOrBlock)\` adds an image you will see, e.g. \`image(await tools.read({ path: "x.png" }))\`. \`notify(text)\` shows a progress line in the app's live trace only. \`exit()\` ends the script. Output over ${OUT_CAP / 1000}k chars is cut in the middle: print summaries, or write big data to a file and page it with tools.read. \`store(key, value)\` / \`load(key)\` keep JSON values across calls. They are for small state (256 KB in all): write big data such as API dumps to files in /scratch with \`tools.bash\` instead.
- Use it to batch independent calls (Promise.allSettled), chain them, or filter large output, instead of many separate tool calls.
- Long work you don't need to wait on: pass \`background: { label, timeout }\` (timeout in seconds, required, max 86400) next to \`code\`. The call returns at once with a job id; the script keeps running, even across restarts, and when it ends its result comes back to you as a \`job\` message. \`tools.jobs()\` lists jobs, \`tools.jobs({ cancel: [id] })\` stops some, \`tools.jobs({ prune: true })\` forgets finished ones. At most 100 run at once.
- Optional first line: \`// @options: {"timeout_ms": 60000}\`

Nested tools:

${tools.map((t) => `### \`${toCodemodeIdentifier(t.name)}\`\n${renderToolSample({ ...t, inputSchema: t.inputSchema as never, outputSchema: { type: "string" } }).trim()}`).join("\n\n")}`;

const discard = (memory: WebAssembly.Memory) => ({
	fd_write(_fd: number, iovs: number, n: number, out: number) {
		const v = new DataView(memory.buffer);
		let w = 0;
		for (let i = 0; i < n; i++) w += v.getUint32(iovs + i * 8 + 4, true);
		v.setUint32(out, w, true);
		return 0;
	},
});

const why = (e: string) => { try { const p = JSON.parse(e); return p.stack ?? p.message ?? e; } catch { return e; } };

export type App = (path: string[], args: unknown) => Promise<string>;

/** Observes a script's tool calls as they start and settle (for live traces). Must not throw. */
export type Hooks = { call(id: number, name: string, args: unknown): void; settle(id: number, ok: boolean, payload: string): void };

// Runs in the VM: any unknown member of `tools` becomes a call path, e.g. tools.vercel.listProjects(args) -> app(["vercel", "listProjects"], args).
const MOUNT = `
const raw = tools;
const at = (path) => new Proxy(() => {}, {
	get: (_, k) => (typeof k === "string" && k !== "then" ? at([...path, k]) : undefined),
	apply: async (_, __, [args]) => { const t = await raw.__app({ path, args }); try { return JSON.parse(t); } catch { return t; } },
});
tools = new Proxy(raw, { get: (o, k) => (typeof k !== "string" || k === "then" || k in o ? o[k] : at([k])) });
`.replace(/\s*\n\s*/g, " ");

// Runs in the VM: timers are host sleeps, so a script waiting on one isn't "stalled".
const TIMERS = `
const __t = new Set(); let __n = 0;
globalThis.setTimeout = (fn, ms = 0, ...a) => { const id = ++__n; __t.add(id); tools.__sleep({ ms: Number(ms) || 0 }).then(() => { if (__t.delete(id)) fn(...a); }); return id; };
globalThis.clearTimeout = (id) => { __t.delete(id); };
globalThis.notify = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); if (!s || !s.trim()) throw new TypeError("notify expects non-empty text"); tools.__notify({ text: s }); };
`.replace(/\s*\n\s*/g, " ");

/** Final result text cap: tool results over ~64 KB get rejected or cut upstream. */
export const OUT_CAP = 50_000;
const capOut = (s: string) => (s.length <= OUT_CAP ? s : `${s.slice(0, OUT_CAP * 0.6)}\n…[${s.length - OUT_CAP} chars cut: print less, or write it to a file in /scratch and page it with tools.read({ path, offset })]…\n${s.slice(-OUT_CAP * 0.4)}`);

const opts = (deadline: number, finished: () => boolean, signal?: AbortSignal) => ({
	wasm, memoryLimit: 256 << 20, maxStackSize: MAX_STACK_SIZE, wasi: discard as never,
	interruptHandler: () => finished() || Date.now() > deadline || !!signal?.aborted,
});

/** Runs a script. With a freezer, the VM is snapshotted (at most once a second) while it waits on tools, and a rerun after a restart thaws it and re-issues only the calls still owed. */
export async function codemode(source: string, nested: Nested[], store: Store, signal?: AbortSignal, app?: App, freezer?: Freezer, until?: number, hooks?: Hooks) {
	const { code, options } = parseCodemodeSource(source);
	const frozen = await freezer?.load();
	const deadline = frozen?.deadline ?? until ?? Date.now() + Math.min(options.timeoutMs ?? 120_000, 600_000);
	const byName = new Map(nested.map((t) => [t.name, t]));
	byName.set("__sleep", { name: "__sleep", description: "", inputSchema: {}, execute: (({ ms }: { ms: number }) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, deadline - Date.now()))))) as Nested["execute"] });
	byName.set("__notify", { name: "__notify", description: "", inputSchema: {}, execute: (async () => "ok") as Nested["execute"] });
	if (app) byName.set("__app", { name: "__app", description: "", inputSchema: {}, execute: (({ path, args }: { path: string[]; args: unknown }) => app(path, args)) as Nested["execute"] });
	const output: string[] = frozen?.output ?? [];
	const images: { data: string; mimeType: string }[] = [];
	const pending = new Map<number, [string, unknown]>();
	let finished = false, dirty = false;
	let done!: (r: { ok: true; value?: string; writes: string } | { ok: false; error: string }) => void;
	const result = new Promise<Parameters<typeof done>[0]>((r) => (done = (x) => { if (!finished) { finished = true; r(x); } }));
	const o = opts(deadline, () => finished, signal);
	const vm = frozen ? await QuickJS.restore(QuickJS.deserializeSnapshot(frozen.image), o) : await QuickJS.create(o);
	try {
		let api!: ReturnType<typeof vm.evalCode>;
		const drain = () => { vm.executePendingJobs(); vm.callFunction(api.getProp("stalled"), api).dispose(); };
		const call = (id: number, name: string, args: unknown) => {
			const t = byName.get(name);
			pending.set(id, [name, args]);
			dirty = true;
			try { hooks?.call(id, name, args); } catch {}
			(t ? t.execute(args as never, id) : Promise.reject(new Error(`Unknown tool "${name}"`)))
				.then((v) => [true, JSON.stringify(v)] as const, (e) => [false, e instanceof Error ? e.message : String(e)] as const)
				.then(([ok, p]) => {
					try { hooks?.settle(id, ok, p); } catch {}
					if (finished) return;
					pending.delete(id);
					dirty = true;
					vm.withScope(() => vm.callFunction(api.getProp("settle"), api, vm.newNumber(id), ok ? vm.true : vm.false, vm.newString(p)));
					drain();
				})
				.catch((e) => done({ ok: false, error: String(e) }));
		};
		const bridge: Parameters<typeof vm.newFunction>[1] = (kind, a, b, c) => {
			const k = kind.toString();
			if (k === "call" || k === "global") call(a.toNumber(), b.toString(), c === undefined || c.isUndefined ? undefined : JSON.parse(c.toString()));
			else if (k === "output") {
				if (a.toString() === "image") { images.push({ data: b.toString(), mimeType: c.toString() }); output.push(`[image ${images.length}]`); }
				else output.push(b.toString());
			}
			else if (k === "done") done(a.toBoolean() ? { ok: true, value: b === undefined || b.isUndefined ? undefined : b.toString(), writes: c.toString() } : { ok: false, error: b.toString() });
			return vm.undefined;
		};
		if (frozen) {
			vm.registerHostCallback("bridge", bridge);
			api = vm.importHandle(frozen.api);
			for (const [id, name, args] of frozen.pending) call(id, name, args);
		} else {
			const fnBridge = vm.newFunction("bridge", bridge);
			const tools = [...byName.values()].map((t) => ({ name: t.name, jsName: toCodemodeIdentifier(t.name), description: t.description }));
			const saved = Object.fromEntries(Object.entries(store).map(([k, v]) => [k, JSON.stringify(v)]));
			api = vm.withScope((s) => s.escape(vm.callFunction(vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"), vm.undefined, fnBridge,
				vm.newString(JSON.stringify(tools)), vm.newString("[]"), vm.newString(JSON.stringify(saved)))));
			try {
				const fn = vm.evalCode(`(async (tools, console) => {${TIMERS}${app ? MOUNT : ""}${code}\n})`, "codemode.js");
				vm.callFunction(api.getProp("run"), api, fn).dispose();
				fn.dispose();
				drain();
			} catch (e) {
				if (!(e instanceof JSException)) throw e;
				done({ ok: false, error: `${e.name}: ${e.message}` });
			}
		}
		const token = vm.exportHandle(api);
		const timer = new Promise<never>((_, rej) => {
			let last = 0;
			const t = setInterval(() => {
				if (finished) clearInterval(t);
				else if (signal?.aborted || Date.now() > deadline) { clearInterval(t); rej(new Error(signal?.aborted ? "aborted" : "timed out")); }
				else if (freezer && dirty && pending.size && Date.now() - last >= 1000) {
					dirty = false;
					last = Date.now();
					void freezer.save({ image: QuickJS.serializeSnapshot(vm.snapshot()), api: token, pending: [...pending].map(([id, [n, a]]) => [id, n, a]), output: [...output], deadline });
				}
			}, 250);
		});
		const r = await Promise.race([result, timer]).catch((e: Error) => ({ ok: false as const, error: e.message }));
		finished = true;
		const out = output.join("\n");
		if (!r.ok) return { text: capOut(`Script failed\n${out}${out ? "\n" : ""}Script error: ${why(r.error)}`), error: true, images };
		for (const [k, v] of JSON.parse(r.writes) as [string, string | undefined][]) v === undefined ? delete store[k] : (store[k] = JSON.parse(v));
		return { text: capOut(`Script completed\n${out}${r.value !== undefined ? `${out ? "\n" : ""}${r.value}` : ""}`), error: false, images };
	} catch (e) {
		finished = true;
		return { text: `Script failed\nScript error: ${e instanceof Error ? e.message : String(e)}`, error: true };
	} finally {
		try { vm.dispose(); } catch {}
	}
}
