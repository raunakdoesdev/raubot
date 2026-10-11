// Zero-secrets-at-rest check for a Boat box: `npm run boat:leaktest` (BOAT_API_KEY in env; `-- --wipe` tests BOAT_WIPE_BROWSER_ON_STOP).
// It installs the template and browser/ on a fresh sandbox, signs in to a local site with vault-backed values (a stand-in `bw` that serves
// random values from its env, since the test has no real vault), stops the sandbox so Boat snapshots it, then looks for those values
// in the snapshot (streamed tar) and, after a resume, across / and the raw root disk. Any match fails it.
// The values exist only in this process's memory and in request bodies and process env/stdin on the box; output names them, never shows them.
// A canary written to disk on purpose must be found by both scans, so a scan that sees nothing can't pass.
import fs from "node:fs";
import crypto from "node:crypto";
import { Boat, daemon, health, prestop, run, type Daemon } from "../../src/core/boat.ts";

const key = process.env.BOAT_API_KEY;
if (!key) throw new Error("BOAT_API_KEY is not set");
const wipe = process.argv.includes("--wipe");
const boat = new Boat(key);
const here = new URL(".", import.meta.url).pathname;
const root = new URL("../../", import.meta.url).pathname;
const rand = () => crypto.randomBytes(18).toString("base64url");

const secrets: Record<string, string> = {
	BW_CLIENTID: `user.${rand()}`, BW_CLIENTSECRET: rand(), BW_PASSWORD: rand(), session: rand(),
	username: `u_${rand()}@example.com`, password: `P!${rand()}#%& x`,
};
const canary = `canary-${rand()}`;

// A passkey for the local site (rpId localhost), non-discoverable like Google's: its private key and credential id are secrets too.
const pk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pkDer = pk.privateKey.export({ type: "pkcs8", format: "der" });
const pkD = Buffer.from(pk.privateKey.export({ format: "jwk" }).d!, "base64url");
const credUuid = crypto.randomUUID();
const credRaw = Buffer.from(credUuid.replace(/-/g, ""), "hex");
const passkey = { credentialId: credUuid, keyType: "public-key", keyAlgorithm: "ECDSA", keyCurve: "P-256", keyValue: pkDer.toString("base64url"), rpId: "localhost",
	userHandle: crypto.randomBytes(16).toString("base64url"), userName: "pk-user", counter: "0", discoverable: "false" };
const passkeySecrets: Record<string, string> = {
	pkKeyB64url: pkDer.toString("base64url"), pkKeyB64: pkDer.toString("base64").replace(/=+$/, ""), pkKeyPemLine: pkDer.toString("base64").slice(0, 64),
	pkScalarB64url: pkD.toString("base64url"), pkScalarHex: pkD.toString("hex"),
	credId: credUuid, credIdHex: credRaw.toString("hex"), credIdB64: credRaw.toString("base64").replace(/=+$/, ""), credIdB64url: credRaw.toString("base64url"),
};
const passkeyBinary: Record<string, Buffer> = { pkKeyDer: pkDer, pkScalarRaw: pkD, credIdRaw: credRaw };
const siteKey = rand();
const items = JSON.stringify([{ id: "11111111-1111-1111-1111-111111111111", name: "Test", login: { username: secrets.username, password: secrets.password, uris: [{ uri: "http://localhost:8099/" }], fido2Credentials: [passkey] } }]);
const vaultEnv = { BW_CLIENTID: secrets.BW_CLIENTID, BW_CLIENTSECRET: secrets.BW_CLIENTSECRET, BW_PASSWORD: secrets.BW_PASSWORD, BW_FAKE_ITEMS: items, BW_FAKE_SESSION: secrets.session, BW_FAKE_PASSWORD: secrets.BW_PASSWORD };
const siteEnv = { SITE_USER: secrets.username, SITE_PASS: secrets.password, SITE_KEY: siteKey, SITE_PK_ID: credRaw.toString("base64url"),
	SITE_PK_PUB: pk.publicKey.export({ type: "spki", format: "pem" }).toString() };

/** Each value as raw bytes and as it might be stored: base64, URL-encoded, form-encoded, UTF-16LE. */
const forms = (v: string) => [...new Set([v, Buffer.from(v).toString("base64").replace(/=+$/, ""), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+")])].map((s) => Buffer.from(s)).concat(Buffer.from(v, "utf16le"));
const needles = [...Object.entries({ ...secrets, ...passkeySecrets }).flatMap(([name, v]) => forms(v).map((b) => ({ name, b }))),
	...Object.entries(passkeyBinary).map(([name, b]) => ({ name, b })), ...forms(canary).slice(0, 1).map((b) => ({ name: "canary", b }))];
const allSecretValues = [...Object.values(secrets), ...Object.values(passkeySecrets)];

// The stand-in bw CLI and the local login site (password form and a passkey) are in test/.
const fakeBw = "#!/usr/bin/env node\n" + fs.readFileSync(here + "test/bw.cjs", "utf8");
const site = fs.readFileSync(here + "test/site.cjs", "utf8");

const t = () => performance.now();
const secs = (a: number) => Math.round((t() - a) / 100) / 10;
const report: Record<string, unknown> = { wipe };
let fail = false;
const check = (name: string, ok: boolean, detail?: unknown) => { report[name] = detail ?? ok; if (!ok) { fail = true; console.error(`FAIL ${name}`, detail ?? ""); } };

async function sh(d: Daemon, cmd: string, o: { ms?: number; env?: Record<string, string>; stdin?: string } = {}) {
	const r = await run(d, cmd, { ms: o.ms ?? 300_000, env: o.env, stdin: o.stdin });
	return r;
}

async function waitState(id: string, want: string[], ms = 300_000) {
	const end = Date.now() + ms;
	for (;;) {
		const s = await boat.get(id);
		if (s && want.includes(s.state)) return s.state;
		if (Date.now() > end) throw new Error(`${id} still ${s?.state}`);
		await new Promise((r) => setTimeout(r, 1000));
	}
}

async function api(path: string) {
	const r = await fetch(`https://boat.dev/api/v1${path}`, { headers: { authorization: `Bearer ${key}` } });
	if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
	return r;
}

/** Streams the snapshot as a tar and counts needle hits per tar entry. Hits are reported by secret name and path only. */
async function scanSnapshot(snapshotId: string) {
	const r = await api(`/snapshots/${snapshotId}/files?path=${encodeURIComponent("/")}`);
	const hits: Record<string, string[]> = {};
	const max = Math.max(...needles.map((n) => n.b.length));
	let buf = Buffer.alloc(0), name = "", left = 0, pad = 0, tail = Buffer.alloc(0), longName = "", bytes = 0, files = 0;
	let meta: Buffer[] | undefined, metaType = "";
	const scan = (chunk: Buffer) => {
		const hay = Buffer.concat([tail, chunk]);
		for (const n of needles) {
			const at = hay.indexOf(n.b);
			if (at >= 0 && at + n.b.length > tail.length) (hits[n.name] ??= []).includes(name) || hits[n.name].push(name);
		}
		tail = hay.subarray(Math.max(0, hay.length - max + 1));
	};
	for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
		bytes += c.length;
		buf = Buffer.concat([buf, Buffer.from(c)]);
		for (;;) {
			if (left > 0) {
				const n = Math.min(left, buf.length);
				if (!n) break;
				if (meta) meta.push(buf.subarray(0, n)); else scan(buf.subarray(0, n));
				buf = buf.subarray(n); left -= n;
				if (left) break;
				if (meta) {
					// GNU long name or pax header: it names the next entry.
					const body = Buffer.concat(meta).toString();
					longName = metaType === "L" ? body.replace(/\0.*$/s, "") : (/\d+ path=(.*)\n/.exec(body)?.[1] ?? "");
					meta = undefined;
				}
				continue;
			}
			if (pad > 0) { const n = Math.min(pad, buf.length); buf = buf.subarray(n); pad -= n; if (pad) break; continue; }
			if (buf.length < 512) break;
			const h = buf.subarray(0, 512); buf = buf.subarray(512);
			if (h.every((x) => x === 0)) continue;
			const str = (a: number, b: number) => h.subarray(a, b).toString().replace(/\0.*$/s, "");
			const size = parseInt(str(124, 136).trim() || "0", 8);
			const type = String.fromCharCode(h[156]);
			const full = (str(345, 500) ? `${str(345, 500)}/` : "") + str(0, 100);
			if (type === "L" || type === "x") { meta = []; metaType = type; left = size; pad = (512 - (size % 512)) % 512; continue; }
			name = longName || full; longName = ""; files++;
			tail = Buffer.alloc(0); left = size; pad = (512 - (size % 512)) % 512;
		}
	}
	return { bytes, files, hits };
}

const inVm = (pattern: string[]) => pattern.join("\n") + "\n";

/** Runs a long scan detached (a daemon request can't stay open past fetch's 300 s header timeout). Its input arrives on tmpfs at $IN, which the scan
 * deletes; its output goes to $OUT on tmpfs; this checks every 15 s whether it's done. */
async function detached(d: Daemon, script: string, stdin: string, ms = 3_600_000) {
	const tag = crypto.randomBytes(6).toString("hex"), IN = `/dev/shm/raubot-in-${tag}`, OUT = `/dev/shm/raubot-out-${tag}`;
	await sh(d, `umask 077; cat > ${IN} && { setsid nohup sudo sh -c '${script.replaceAll("$IN", IN).replaceAll("$OUT", OUT).replace(/'/g, "'\\''")}; rm -f ${IN}; touch ${OUT}.done' >${OUT}.err 2>&1 < /dev/null & }; echo started`, { stdin });
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 15_000))) {
		const o = await sh(d, `test -e ${OUT}.done && { sudo cat ${OUT} ${OUT}.err; sudo rm -f ${OUT} ${OUT}.done ${OUT}.err; echo; echo DONE; }; true`, { ms: 60_000 });
		if (o.out.trimEnd().endsWith("DONE")) return o.out.trimEnd().slice(0, -4).trim();
	}
	throw new Error(`scan didn't finish in ${ms / 60_000} min`);
}

/** Maps raw-disk byte offsets to the file that owns the block (debugfs icheck + ncheck), or "free block". */
async function where(d: Daemon, dev: string, hits: (readonly [string, number])[]) {
	if (!hits.length) return [];
	const bs = Number((await sh(d, `sudo tune2fs -l ${dev} | awk '/^Block size/{print $3}'`)).out.trim());
	const rows = (out: string) => new Map(out.split("\n").slice(1).map((l) => l.split("\t").map((x) => x.trim())).filter((x) => x.length === 2) as [string, string][]);
	const inode = rows((await sh(d, `sudo debugfs -R "icheck ${[...new Set(hits.map(([, o]) => Math.floor(o / bs)))].join(" ")}" ${dev} 2>/dev/null`, { ms: 300_000 })).out);
	const inodes = [...new Set([...inode.values()].filter((i) => /^\d+$/.test(i)))];
	const path = inodes.length ? rows((await sh(d, `sudo debugfs -R "ncheck ${inodes.join(" ")}" ${dev} 2>/dev/null`, { ms: 300_000 })).out) : new Map();
	return hits.map(([n, o]) => {
		const i = inode.get(String(Math.floor(o / bs)));
		return `${n} @${o}: ${i && /^\d+$/.test(i) ? (path.get(i) ?? `inode ${i}`) : "free block"}`;
	});
}

const rawFirst = process.env.LEAK_RAW_FIRST === "1";
const swap = async (d: Daemon) => (await sh(d, "swapon --show=NAME,USED --noheadings | tr '\\n' ' '; sudo stat -c 'inode %i born %W' /swapfile 2>&1")).out.trim();

const id = await boat.create(undefined);
report.sandbox = id;
try {
	let a = t();
	await boat.ready(id);
	report.createS = secs(a);
	a = t();
	const files = ["manifest.json", "install.sh", "boatd.mjs", "firewall.sh", "raubot-boatd.service", "raubot-firewall.service"];
	await boat.bootstrap(id, Object.fromEntries(files.map((f) => [f, fs.readFileSync(here + f, "utf8")])));
	let d = await daemon(boat, id);
	await health(d);
	report.templateInstallS = secs(a);

	a = t();
	const browserFiles = ["cli.mjs", "server.mjs", "launch.mjs", "vault.mjs", "passkeys.mjs", "package.json", "package-lock.json", "vault"];
	await Promise.all([...browserFiles.map((f) => boat.file(id, `raubot/browser/${f}`, fs.readFileSync(`${root}browser/${f}`, "utf8"))),
		boat.file(id, ".raubot-test/bw", fakeBw), boat.file(id, ".raubot-test/site.js", site)]);
	const inst = await sh(d, "cd ~/raubot/browser && chmod +x vault ~/.raubot-test/bw && npm ci -s --no-audit --no-fund 2>&1 | tail -3 && ln -sf $PWD/vault /usr/local/bin/vault && command -v google-chrome-stable", { ms: 600_000 });
	check("browserInstall", inst.exitCode === 0, inst.exitCode ? inst.out.slice(-400) : true);
	report.browserInstallS = secs(a);

	// Files and an apt package that must survive the stop.
	await sh(d, "cat > ~/workspace/canary.txt && sudo apt-get install -y -qq cowsay >/dev/null 2>&1; echo installed", { stdin: canary });
	const startSite = (dd: Daemon) => sh(dd, "setsid nohup node ~/.raubot-test/site.js >/dev/null 2>&1 < /dev/null & sleep 1; curl -fsS -o /dev/null -w '%{http_code}' http://localhost:8099/", { env: siteEnv });
	check("siteUp", (await startSite(d)).out.includes("200"));

	const browse = (dd: Daemon, code: string) => sh(dd, "cd ~/workspace && BW_BIN=$HOME/.raubot-test/bw node ~/raubot/browser/cli.mjs run", { env: vaultEnv, stdin: JSON.stringify({ code, timeout: 120 }), ms: 300_000 });
	a = t();
	const login = await browse(d, `await page.goto("http://localhost:8099/");
await vault.fill("#u", "bw://Test/username");
await page.click("#p"); await vault.type("bw://Test/password");
await Promise.all([page.waitForURL("**/home"), page.click("button")]);
return await page.textContent("#w");`);
	const loginOut = (() => { try { return JSON.parse(login.out.trim().split("\n").at(-1)!) as { out: string; error?: boolean }; } catch { return { out: login.out.slice(-600), error: true }; } })();
	const leakedInOutput = allSecretValues.some((v) => login.out.includes(v));
	check("vaultLogin", !loginOut.error && loginOut.out.includes("welcome"), loginOut.error ? loginOut.out.replace(/[\s\S]*(Error[\s\S]{0,400})/, "$1") : true);
	check("noValueInBrowserOutput", !leakedInOutput);
	report.vaultLoginS = secs(a);

	const pkLogin = (dd: Daemon) => browse(dd, `await page.goto("http://localhost:8099/pk"); await page.waitForURL("**/pkhome", { timeout: 30000 }).catch(() => {}); return (await page.title()) + " | " + page.url();`);
	const pkOut = (r: { out: string }) => { try { return (JSON.parse(r.out.trim().split("\n").at(-1)!) as { out: string }).out; } catch { return r.out.slice(-300); } };
	const loaded = async (dd: Daemon) => (await sh(dd, "curl -s --unix-socket /tmp/raubot-browser.sock -X POST -d '{}' http://x/loaded")).out.trim();
	a = t();
	const pk1 = await pkLogin(d);
	check("passkeyLogin", pkOut(pk1).startsWith("pk home"), pkOut(pk1));
	check("noValueInPasskeyOutput", !allSecretValues.some((v) => pk1.out.includes(v)));
	report.passkeyLoginS = secs(a);
	check("passkeysRemovedAfterRun", (await loaded(d)) === '{"ok":0}', await loaded(d));

	const vr = await sh(d, "cd ~/workspace && BW_BIN=$HOME/.raubot-test/bw vault run --env P=bw://Test/password -- sh -c 'printf %s \"$P\" | sha256sum'", { env: vaultEnv });
	check("vaultRun", vr.out.includes(crypto.createHash("sha256").update(secrets.password).digest("hex")), vr.exitCode);
	const shm = await sh(d, "ls /dev/shm/raubot-bw 2>/dev/null; test ! -e ~/.raubot/bw && echo no-disk-bw-dir");
	check("bitwardenDataOnTmpfs", shm.out.includes("data.json") && shm.out.includes("no-disk-bw-dir"), shm.out.trim());

	// Stop: the box's pre-stop hook, then Boat stops it and snapshots the disk.
	report.swapBeforeStop = await swap(d);
	await sh(d, prestop(wipe), { ms: 60_000 });
	a = t();
	await boat.stop(id);
	const stopped = await waitState(id, ["archived", "stopped"]);
	report.stopS = secs(a); report.stoppedState = stopped;
	const latest = (await (await api(`/sandboxes/${id}/snapshots/latest`)).json()) as { snapshot?: { id: string } | null; id?: string };
	const snapId = latest.snapshot?.id ?? latest.id;
	check("snapshotExists", !!snapId);
	a = t();
	const snap = await scanSnapshot(snapId!);
	report.snapshotScan = { s: secs(a), mb: Math.round(snap.bytes / 1e6), files: snap.files, controlFoundIn: snap.hits.canary ?? [] };
	check("snapshotControlFound", (snap.hits.canary ?? []).length > 0);
	const snapLeaks = Object.fromEntries(Object.entries(snap.hits).filter(([k]) => k !== "canary"));
	check("snapshotZeroSecrets", !Object.keys(snapLeaks).length, Object.keys(snapLeaks).length ? snapLeaks : 0);

	// Resume and look again from inside, over files and the raw root disk (which also holds deleted files' blocks).
	a = t();
	await boat.resume(id);
	await boat.ready(id);
	report.resumeS = secs(a);
	try { await health(d, 20_000); report.daemonAfterResume = "same url"; } catch { d = await daemon(boat, id); await health(d); report.daemonAfterResume = "re-hosted"; }
	report.resumeToDaemonS = secs(a);
	report.swapAfterResume = await swap(d);
	const rawScan = async () => {
		// The raw root disk, deleted blocks included: every needle (text and binary). The scan runs detached; the needles reach it through tmpfs, which it deletes.
		a = t();
		const dev = (await sh(d, "findmnt -no SOURCE /")).out.trim();
		await boat.file(id, ".raubot-test/rawscan.py", fs.readFileSync(here + "test/rawscan.py", "utf8"));
		const raw = JSON.parse(await detached(d, `python3 /home/user/.raubot-test/rawscan.py ${dev} $IN $OUT`, needles.map((n) => n.b.toString("hex")).join("\n") + "\n")) as { bytes: number; hits: Record<string, number>; offsets: Record<string, number[]> };
		const rawHits = Object.entries(raw.hits).map(([i, c]) => [needles[Number(i)].name, c] as const);
		const rawSecrets = rawHits.filter(([n]) => n !== "canary");
		report.rawDisk = { device: dev, s: secs(a), gb: Math.round(raw.bytes / 1e8) / 10, control: rawHits.filter(([n]) => n === "canary").reduce((x, [, c]) => x + c, 0), secrets: Object.fromEntries(rawSecrets) };
		report.rawDiskWhere = await where(d, dev, Object.entries(raw.offsets).flatMap(([i, os]) => os.map((o) => [needles[Number(i)].name, o] as const)));
		check("rawDiskControlFound", rawHits.some(([n]) => n === "canary"));
		check("rawDiskZeroSecrets", !rawSecrets.length);
	};
	report.rawScanAt = rawFirst ? "right after resume" : "after the post-resume checks";
	if (rawFirst) await rawScan();

	const persist = await sh(d, "sha256sum < ~/workspace/canary.txt; test -x /usr/games/cowsay && echo cowsay; test -d ~/raubot/browser/node_modules && echo node_modules");
	check("filePersisted", persist.out.includes(crypto.createHash("sha256").update(canary).digest("hex")));
	check("aptInstallPersisted", persist.out.includes("cowsay"));
	check("npmInstallPersisted", persist.out.includes("node_modules"));

	await startSite(d);
	const after = await browse(d, `await page.goto("http://localhost:8099/home"); return await page.title();`);
	const title = (() => { try { return (JSON.parse(after.out.trim().split("\n").at(-1)!) as { out: string }).out; } catch { return after.out.slice(-300); } })();
	if (wipe) check("browserWipedOnStop", title.includes("login"), title);
	else check("browserLoginPersisted", title.includes("home"), title);
	const pkSess = await browse(d, `await page.goto("http://localhost:8099/pkhome"); return await page.title();`);
	if (!wipe) check("passkeySessionPersisted", pkOut(pkSess).startsWith("pk home"), pkOut(pkSess));
	const pk2 = await pkLogin(d);
	check("passkeyLoginAfterResume", pkOut(pk2).startsWith("pk home"), pkOut(pk2));
	check("passkeysRemovedAfterResumeRun", (await loaded(d)) === '{"ok":0}');

	// UTF-16 forms (with NULs) are left to the snapshot scan; grep patterns are lines of text.
	const secretPatterns = needles.filter((n) => n.name !== "canary" && !n.b.includes(0)).map((n) => n.b.toString());
	a = t();
	const grep = await detached(d, "grep -rlaF -f $IN --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev --exclude-dir=run / 2>/dev/null | head -50 > $OUT", inVm([...secretPatterns, canary]));
	const found = grep.split("\n").filter(Boolean);
	report.vmGrep = { s: secs(a), controlFoundIn: found.filter((f) => f.endsWith("canary.txt")) };
	check("vmGrepControlFound", found.some((f) => f.endsWith("canary.txt")));
	const vmLeaks = found.filter((f) => !f.endsWith("canary.txt"));
	check("vmGrepZeroSecrets", !vmLeaks.length, vmLeaks.length ? vmLeaks : 0);
	if (!rawFirst) await rawScan();
} catch (e) {
	fail = true;
	report.error = String(e).replace(new RegExp(allSecretValues.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"), "[secret]");
} finally {
	await boat.remove(id).then(() => (report.deleted = true), (e) => (report.deleted = String(e)));
}
report.pass = !fail;
console.log(JSON.stringify(report, null, 1));
process.exit(fail ? 1 : 0);
