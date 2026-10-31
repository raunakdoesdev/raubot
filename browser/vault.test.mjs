// node browser/vault.test.mjs: Raunak's blocklist against the stand-in bw (box/boat/test/bw.cjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { blockReason } from "./blocklist.mjs";

const dir = fs.mkdtempSync(`${os.tmpdir()}/vault-test-`);
process.env.RAUBOT_BW_DIR = dir;
const vault = await import("./vault.mjs");

const login = (id, name, uri, extra = {}) => ({ id, name, type: 1, login: { username: "u", password: `pw-${id}`, totp: "JBSWY3DPEHPK3PXP", uris: uri ? [{ uri }] : [], fido2Credentials: [] }, ...extra });
const items = [
	login("1", "GitHub", "https://github.com/login", { login: { username: "u", password: "pw-1", totp: "JBSWY3DPEHPK3PXP", uris: [{ uri: "https://github.com/login" }], fido2Credentials: [{ rpId: "github.com", credentialId: "a" }] } }),
	login("2", "My checking", "https://secure.chase.com/web/auth"),
	login("3", "Personal stuff", "https://example.org", { folderId: "f-block" }),
	login("4", "Mercury", ""),
	login("5", "Old login", "", { login: { username: "u", password: "pw-5", uris: [], fido2Credentials: [{ rpId: "robinhood.com", credentialId: "b" }] } }),
	{ id: "6", name: "Visa 9232", type: 3, card: { number: "4111111111111111", brand: "Visa" } },
];
const env = { BW_BIN: new URL("../box/boat/redteam/bw", import.meta.url).pathname, BW_FAKE_PASSWORD: "p", BW_FAKE_SESSION: "s", BW_FAKE_ITEMS: JSON.stringify(items), BW_FAKE_FOLDERS: JSON.stringify([{ id: "f-block", name: "raubot-blocked" }, { id: "f-other", name: "Work" }]) };
Object.assign(process.env, env);

const names = (await vault.find(env, [])).map((i) => i.name).sort();
assert.deepEqual(names, ["GitHub", "Visa 9232"], "find hides blocked items");
assert.equal((await vault.find(env, ["chase"])).length, 0, "find by a blocked domain finds nothing");

assert.equal(await vault.resolve(env, "bw://GitHub/password"), "pw-1", "unblocked item still resolves");
assert.match(await vault.resolve(env, "bw://GitHub/totp"), /^\d{6}$/, "unblocked totp still works");
assert.equal(await vault.resolve(env, "bw://Visa 9232/card/number"), "4111111111111111", "cards aren't blocked by the money list");
for (const ref of ["bw://My checking/password", "bw://2/totp", "bw://Personal stuff/notes", "bw://3/username", "bw://Mercury", "bw://5/password"])
	await assert.rejects(vault.resolve(env, ref), /blocked by Raunak's vault blocklist/, `${ref} refused`);
assert.deepEqual((await vault.passkeys(env)).map((p) => p.rpId), ["github.com"], "blocked passkeys never load");
assert.deepEqual((await vault.logins(env)).map((i) => i.id).sort(), ["1", "6"], "logins() hides blocked items");

const moved = await vault.quarantine(env, true);
assert.deepEqual(moved.map((m) => m.name).sort(), ["Mercury", "My checking", "Old login"], "dry run lists money items not yet in the folder");
assert.ok(moved.every((m) => !("login" in m) && !JSON.stringify(m).includes("pw-")), "dry run carries no values");

assert.equal(blockReason({ name: "Purchase orders", type: 1 }, new Set()), undefined, "'purchase' is not chase");
assert.equal(blockReason({ name: "x", type: 1, login: { uris: [{ uri: "https://www.navyfederal.org" }] } }, new Set()), undefined, "unknown domain without a bank word passes");
assert.ok(blockReason({ name: "x", type: 1, login: { uris: [{ uri: "https://online.firsttechcreditunion.com" }] } }, new Set()), "credit union domain blocked");
assert.ok(blockReason({ name: "--", type: 1, login: { uris: [{ uri: "androidapp://com.paypal.android.p2pmobile" }] } }, new Set()), "android app uri blocked");
assert.ok(blockReason({ name: "--", type: 1, login: { uris: [{ uri: "android://aGFzaA==@com.paypal.android.p2pmobile/" }] } }, new Set()), "bitwarden android uri blocked");
assert.equal(blockReason({ name: "--", type: 1, login: { uris: [{ uri: "android://aGFzaA==@com.facebook.katana/" }] } }, new Set()), undefined, "other android apps pass");
assert.ok(blockReason({ name: "Golden 1 Credit Union", type: 2 }, new Set()), "credit union note blocked");
fs.rmSync(dir, { recursive: true, force: true });
console.log("vault blocklist ok");
