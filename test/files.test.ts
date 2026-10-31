import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxName, byteRange, pagePath, resolveBox, SLICE } from "../src/app/fsparse.ts";

const PY = new URL("../src/app/fsview.py", import.meta.url).pathname;
const fv = (a: object) => JSON.parse(execFileSync("python3", [PY], { input: JSON.stringify(a) }).toString());

// A fake box tree with secrets sprinkled in.
const root = mkdtempSync(join(tmpdir(), "fsv-"));
const put = (p: string, s = "x") => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), s); };
put("ok/readme.md", "# hi"); put("ok/video.mp4", "0123456789"); put("ok/src/app.ts", "let x = 1");
put("ok/.env", "SECRET=1"); put("ok/.env.local"); put("ok/prod.env"); put("ok/cf-svc.json"); put("ok/github_token.txt"); put("ok/api-key.txt");
put("ok/.ssh/id_ed25519"); put("ok/.git/config", "[remote] url=https://x:tok@h"); put("ok/.git/HEAD", "ref");
put("ok/Bitwarden CLI/data.json"); put("ok/.config/gh/hosts.yml"); put("ok/chrome/Default/Cookies"); put("ok/chrome/Default/Login Data");
put("ok/.bash_history"); put("ok/.cloudflared/x-token.url"); put("ok/mdata/bridge.db"); put("ok/bridge.db-wal"); put("ok/server.pem"); put("ok/vault-export.json"); put("ok/auth.json");
symlinkSync("/proc/self", join(root, "ok/proc-link"));
symlinkSync(join(root, "ok/.ssh"), join(root, "ok/keys"));

const names = (p: string) => (fv({ op: "list", path: p }).entries as { name: string }[]).map((e) => e.name).sort();
const top = names(join(root, "ok"));
for (const hidden of [".env", ".env.local", "prod.env", "cf-svc.json", "github_token.txt", "api-key.txt", ".ssh", "Bitwarden CLI", ".bash_history", "server.pem", "vault-export.json", "auth.json", "proc-link", "keys", ".cloudflared", "mdata", "bridge.db-wal"])
	assert.ok(!top.includes(hidden), "hidden: " + hidden + " in " + top);
for (const shown of ["readme.md", "video.mp4", "src", ".git", ".config", "chrome"]) assert.ok(top.includes(shown), "shown: " + shown);
assert.deepEqual(names(join(root, "ok/.git")), ["HEAD"], ".git/config hidden, HEAD shown");
assert.deepEqual(names(join(root, "ok/chrome/Default")), [], "browser login stores hidden");
assert.deepEqual(names(join(root, "ok/.config")), [], "gh config hidden");

// Direct reads of secrets are refused, including through symlinks and ../ tricks.
const denied = (p: string) => assert.equal(fv({ op: "read", path: p }).status, 403, "denied: " + p);
for (const p of ["ok/.env", "ok/cf-svc.json", "ok/.ssh/id_ed25519", "ok/.git/config", "ok/keys/id_ed25519", "ok/src/../.env", "ok/Bitwarden CLI/data.json", "ok/chrome/Default/Cookies"]) denied(join(root, p));
for (const p of ["/proc/self/environ", "/proc/1/environ", "/sys/kernel", "/dev/mem", "/etc/shadow", join(root, "ok/proc-link/environ")]) denied(p);
assert.equal(fv({ op: "list", path: "/proc" }).status, 403, "no /proc listing");
assert.equal(fv({ op: "lists", paths: ["/proc"] }).lists["/proc"].status, 403, "no /proc in batch");
assert.equal(fv({ op: "read", path: "relative" }).status, 403, "relative path refused");

// Normal reads, ranges, batch lists, stat, search.
const r = fv({ op: "read", path: join(root, "ok/video.mp4"), offset: 2, length: 3 });
assert.equal(Buffer.from(r.b64, "base64").toString(), "234"); assert.equal(r.size, 10);
const b = fv({ op: "lists", paths: [join(root, "ok"), join(root, "ok/src")] }).lists;
assert.equal(b[join(root, "ok/src")].entries[0].name, "app.ts");
assert.equal(fv({ op: "stat", path: join(root, "ok/readme.md") }).size, 4);
const hits = (fv({ op: "find", path: root, q: "env" }).hits as { path: string }[]).map((h) => h.path);
assert.deepEqual(hits, [], "search never finds secrets: " + hits);
assert.ok((fv({ op: "find", path: root, q: "app" }).hits as { path: string }[]).some((h) => h.path.endsWith("src/app.ts")), "search finds app.ts");
assert.ok(fv({ op: "roots" }).roots.includes("/"), "roots include /");
const slash = (fv({ op: "list", path: "/" }).entries as { name: string }[]).map((e) => e.name);
for (const v of ["proc", "sys", "dev"]) assert.ok(!slash.includes(v), "/ hides " + v);

// Pure helpers.
assert.equal(boxName(null), "main"); assert.equal(boxName("0"), "main"); assert.equal(boxName("45195"), "agent-45195"); assert.equal(boxName("agent-7"), "agent-7");
assert.equal(boxName("../main"), undefined); assert.equal(boxName("agent-x"), undefined);
// The viewer, screen and takeover open the box an agent really runs in: a vm "shared" subagent's is its caller's.
const stored: Record<number, string> = { 7: "main", 8: "agent-3", 9: "agent-9" };
const asked: number[] = [];
const lookup = async (id: number) => { asked.push(id); return stored[id]; };
assert.equal(await resolveBox(boxName("7")!, lookup), "main", "shared under raubot opens raubot's box");
assert.equal(await resolveBox(pagePath("~8/x.html").box, lookup), "agent-3", "shared under agent 3 opens agent 3's box");
assert.equal(await resolveBox("agent-9", lookup), "agent-9", "own box stays its own");
assert.equal(await resolveBox("agent-42", lookup), "agent-42", "unknown agent keeps its own name");
assert.equal(await resolveBox("main", lookup), "main");
assert.deepEqual(asked, [7, 8, 9, 42], "main needs no lookup");
assert.deepEqual(byteRange("bytes=0-", 100), { start: 0, end: 99 });
assert.deepEqual(byteRange("bytes=10-19", 100), { start: 10, end: 19 });
assert.deepEqual(byteRange("bytes=-10", 100), { start: 90, end: 99 });
assert.equal(byteRange("bytes=200-", 100), "bad");
assert.equal(byteRange(null, 100), undefined); assert.equal(byteRange("bytes=1-2,4-5", 100), undefined);
assert.deepEqual(byteRange("bytes=0-", SLICE * 3), { start: 0, end: SLICE - 1 }, "clipped to a slice");
assert.deepEqual(pagePath("research/x.html"), { box: "main", path: "/workspace/research/x.html" });
assert.deepEqual(pagePath("scratch/a%20b.png"), { box: "main", path: "/scratch/a b.png" });
assert.deepEqual(pagePath("~45195/research/x.html"), { box: "agent-45195", path: "/workspace/research/x.html" });
assert.deepEqual(pagePath("~45195/~root/tmp/v/index.html"), { box: "agent-45195", path: "/tmp/v/index.html" });
console.log("files ok");
