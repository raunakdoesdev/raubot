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

// Screenshot uploads: the shell helper's signature, checks, and delivery with the next message.
const ir = ((await run(devin.add("img run", { channel: "imessage", to: "+1" }, "runimg", "devin-img"))) as any).right as devin.Run;
const ci = devin.curl("https://x", ir);
ok(/devin_image/.test(ci.prompt), "prompt carries devin_image helper");
const fs = await import("node:fs");
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
fs.writeFileSync("/tmp/shot one.png", png);
fs.writeFileSync("/tmp/shot.png", png);
const ish = ci.image.replace("curl -sS", "printf '%s\\n'") + "\ndevin_image /tmp/shot.png";
const il = execSync(ish, { shell: "/bin/bash" }).toString().split("\n");
const its = il.find((l) => l.startsWith("x-raubot-ts: "))!.slice(13), isig = il.find((l) => l.startsWith("x-raubot-sig: "))!.slice(14);
ok(il.some((l) => l.endsWith("/s/devin/runimg/image?name=shot.png")), "upload goes to /s/devin/<key>/image?name=");
ok(((await run(devin.image("runimg", "shot.png", its, "0".repeat(64), png))) as any).left?.status === 401, "image: bad signature refused");
ok(((await run(devin.image("runimg", "other.png", its, isig, png))) as any).left?.status === 401, "image: renamed file refused");
ok(((await run(devin.image("runimg", "shot.png", its, isig, Uint8Array.from([...png, 9])))) as any).left?.status === 401, "image: altered bytes refused");
const notimg = new TextEncoder().encode("hello");
const nsig = await devin.sign(ir.secret, its + ".image.x.txt." + [...new Uint8Array(await crypto.subtle.digest("SHA-256", notimg))].map((x) => x.toString(16).padStart(2, "0")).join(""));
ok(((await run(devin.image("runimg", "x.txt", its, nsig, notimg))) as any).left?.status === 415, "image: non-image refused");
const ig = (await run(devin.image("runimg", "shot.png", its, isig, png))) as any;
ok(ig._tag === "Right" && /^uploads\/devin\/img\/\d{4}-\d\d-\d\d\/[\w]+-shot\.png$/.test(ig.right.path), "image saved under uploads/devin/<session>/<date>/");
ok(((await run(devin.image("runimg", "shot.png", its, isig, png))) as any).left?.status === 409, "image: replay refused");
ok(devin.imageType(Uint8Array.from([0xff, 0xd8, 0xff, 0])) === "jpg" && devin.imageType(new TextEncoder().encode("GIF89a")) === "gif" && devin.imageType(new TextEncoder().encode("RIFF1234WEBPVP8 ")) === "webp", "jpg/gif/webp detected");
// Callback delivers the held images and clears them.
const csh = ci.curl.replace("curl -sS", "printf '%s\\n'") + "\ndevin_done done 'shipped'";
const cl = execSync(csh, { shell: "/bin/bash" }).toString().split("\n");
const cts = cl.find((l) => l.startsWith("x-raubot-ts: "))!.slice(13), csig = cl.find((l) => l.startsWith("x-raubot-sig: "))!.slice(14);
const cb = (await run(devin.callback("runimg", "done", cts, csig, "shipped"))) as any;
ok(cb._tag === "Right" && cb.right.images.length === 1 && cb.right.images[0] === ig.right.path, "callback carries uploaded images");
ok((((await run(devin.get("runimg"))) as any).right.images ?? []).length === 0, "images cleared after delivery");
// Safety net: a delivered note carries held images; a silent check keeps them.
const sr = { ...b, images: ["uploads/devin/bbb/x.png"], notified: undefined } as devin.Run;
const so = devin.review([sr], "Session devin-bbb:\n  status: running\n  status_detail: waiting_for_user\n");
ok(so[0].text && so[0].images?.[0] === "uploads/devin/bbb/x.png" && (so[0].run.images ?? []).length === 0, "safety-net note carries images");
const quiet = devin.review([{ ...sr, notified: "running/waiting_for_user" }], "Session devin-bbb:\n  status: running\n  status_detail: waiting_for_user\n");
ok(!quiet[0].text && quiet[0].run.images?.length === 1, "silent check keeps images for later");

