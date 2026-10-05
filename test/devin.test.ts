import { Effect } from "effect";
import { execSync } from "node:child_process";
import * as devin from "../src/core/devin.ts";
import { Storage } from "../src/core/fx.ts";

const m = new Map<string, unknown>();
const store = { get: async (k: string) => m.get(k), put: async (e: Record<string, unknown>) => { for (const [k, v] of Object.entries(e)) m.set(k, structuredClone(v)); },
	delete: async (ks: string[]) => { for (const k of ks) m.delete(k); }, list: async ({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix))) } as unknown as DurableObjectStorage;
const run = <A, E>(e: Effect.Effect<A, E, Storage>) => Effect.runPromise(Effect.either(Effect.provideService(e, Storage, store)));
const ok = (c: boolean, s: string) => { console.log((c ? "PASS " : "FAIL ") + s); if (!c) process.exitCode = 1; };

const r = (await run(devin.add("test run", { channel: "app" }))) as { right: devin.Run };
const run1 = r.right;
const c = devin.curl("https://x", run1);
// Run the generated shell function with curl replaced by a printer, so we capture what Devin would send.
const sh = c.curl.replace("curl -sS", "printf '%s\\n'") + "\ndevin_done done 'Opened PR #1 \"quoted\" & done'";
const lines = execSync(sh, { shell: "/bin/bash" }).toString().split("\n");
const ts = lines.find((l) => l.startsWith("x-raubot-ts: "))!.slice(13), sig = lines.find((l) => l.startsWith("x-raubot-sig: "))!.slice(14);
const body = "Opened PR #1 \"quoted\" & done";
const bad = await run(devin.callback(run1.key, "done", ts, "0".repeat(64), body));
ok(bad._tag === "Left" && (bad as any).left.status === 401, "bad signature refused");
const stale = await run(devin.callback(run1.key, "done", String(Number(ts) - 1000), sig, body));
ok(stale._tag === "Left", "stale timestamp refused");
const tampered = await run(devin.callback(run1.key, "blocked", ts, sig, body));
ok(tampered._tag === "Left", "tampered status refused");
const good = await run(devin.callback(run1.key, "done", ts, sig, body));
ok(good._tag === "Right" && (good as any).right.text.startsWith("[devin " + run1.key + " done] test run"), "valid signature from shell curl accepted");
ok(((await run(devin.get(run1.key))) as any).right.status === "closed", "done closes run");
const replay = await run(devin.callback(run1.key, "done", ts, sig, body));
ok(replay._tag === "Left" && (replay as any).left.status === 409, "replay refused");

// Safety net
const a = ((await run(devin.add("p", { channel: "app" }, "runaaa", "devin-aaa"))) as any).right as devin.Run;
const b = ((await run(devin.add("q", { channel: "app" }, "runbbb", "bbb"))) as any).right as devin.Run;
const old = { ...((await run(devin.add("s", { channel: "app" }, "runccc", "ccc"))) as any).right, started: Date.now() - 30 * devin.HOUR } as devin.Run;
const text = "Session devin-aaa:\n  status: exit\n  status_detail: finished\n  summary: did it\nSession devin-bbb:\n  status: running\n  status_detail: waiting_for_user\nSession devin-ccc:\n  status: running\n  status_detail: working\n";
const out = devin.review([a, b, old], text);
ok(out[0].run.status === "closed" && /done, no callback/.test(out[0].text!) && /did it/.test(out[0].text!), "finished w/o callback -> message + close");
ok(out[1].run.status === "open" && /blocked/.test(out[1].text!), "waiting_for_user -> blocked message, stays open");
ok(/stuck/.test(out[2].text!) && out[2].run.flagged, "stale -> flagged");
const again = devin.review(out.map((o) => o.run), text);
ok(again.every((o) => !o.text), "no repeat messages next hour");
