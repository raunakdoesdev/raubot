import assert from "node:assert/strict";
import { exempt, gate, scrub, verify } from "../src/app/access.ts";
import { same } from "../src/core/crypto.ts";
import { failedNote, FAILED, MIN_LEN, redact, ASK_TTL } from "../src/core/secrets.ts";

const TEAM = "testteam", AUD = "aud-123", ISS = `https://${TEAM}.cloudflareaccess.com`;
const gen = async () => (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const kp = await gen(), other = await gen();
const pub = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256" };
let fetches = 0;
globalThis.fetch = (async (u: string) => {
	fetches++;
	assert.equal(String(u), `${ISS}/cdn-cgi/access/certs`);
	return Response.json({ keys: [pub] });
}) as typeof fetch;
const b64 = (o: object | Uint8Array) => Buffer.from(o instanceof Uint8Array ? o : JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const mint = async (p: object, key = kp.privateKey, h: object = { alg: "RS256", kid: "k1", typ: "JWT" }) => {
	const head = b64(h) + "." + b64(p);
	const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head)));
	return head + "." + b64(sig);
};
const base = { aud: [AUD], email: "raunak@reducto.ai", iss: ISS, iat: now, nbf: now, exp: now + 600, sub: "u1", type: "app" };

const ok = await verify(await mint(base), TEAM, AUD);
assert.ok(ok.ok && ok.id.email === "raunak@reducto.ai", "valid user token");
const svc = await verify(await mint({ ...base, email: "", sub: "", common_name: "abc.access" }), TEAM, AUD);
assert.ok(svc.ok && svc.id.service === "abc.access", "valid service token");
const fail = async (p: object, why: string, key?: CryptoKey, h?: object) => { const r = await verify(await mint(p, key, h), TEAM, AUD); assert.ok(!r.ok && r.why === why, why + " -> " + JSON.stringify(r)); };
await fail(base, "signature", other.privateKey);
await fail({ ...base, aud: ["other"] }, "aud");
await fail({ ...base, exp: now - 3600 }, "expired");
await fail({ ...base, nbf: now + 3600 }, "nbf");
await fail({ ...base, iss: "https://evil.cloudflareaccess.com" }, "iss");
await fail(base, "alg", undefined, { alg: "none", kid: "k1" });
await fail({ ...base, email: "", common_name: "" }, "no identity");
assert.ok(!(await verify("garbage", TEAM, AUD)).ok);
// Tampered payload with the original signature.
{ const t = (await mint(base)).split("."); t[1] = b64({ ...base, email: "attacker@x.com" }); assert.ok(!(await verify(t.join("."), TEAM, AUD)).ok, "tampered payload"); }
assert.ok(fetches <= 2, "certs cached");

// The gate: default deny, exempt routes, header or cookie.
const env = { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD };
const req = (path: string, init: RequestInit = {}, host = "https://raubot.reducto.ai") => new Request(host + path, init);
const status = async (r: Request, e: object = env) => (await gate(r, e as typeof env))?.status ?? 200;
const good = await mint(base);
for (const p of ["/files.json", "/file/research/x.html", "/box", "/agent/1/screen.jpg", "/ws", "/settings.json", "/secrets.json", "/traces.json", "/reset", "/", "/login", "/oauth/start", "/whatever"]) {
	assert.equal(await status(req(p)), 403, "no token -> 403 " + p);
	assert.equal(await status(req(p, { headers: { "cf-access-jwt-assertion": "x.y.z" } })), 403, "bogus header -> 403 " + p);
	assert.equal(await status(req(p, { headers: { "cf-access-jwt-assertion": good } })), 200, "valid header ok " + p);
}
assert.equal(await status(req("/box", { method: "POST", headers: { cookie: "a=b; CF_Authorization=" + good } })), 200, "cookie ok");
assert.equal(await status(req("/box", { method: "POST", headers: { "cf-access-jwt-assertion": await mint({ ...base, exp: now - 3600 }) } })), 403, "expired -> 403");
assert.equal(await status(req("/box", { method: "POST", headers: { "cf-access-jwt-assertion": await mint({ ...base, aud: ["x"] }) } })), 403, "wrong aud -> 403");
const T = "/s/" + "a".repeat(32);
for (const [m, p] of [["POST", "/imessage"], ["POST", "/s/devin/abcdef"], ["GET", "/s/oidc/.well-known/jwks.json"], ["POST", "/s/oidc/token"], ["GET", "/s/og.png"], ["GET", "/s/assets/x.js"], ["GET", T], ["GET", T + ".json"]] as const)
	assert.equal(await status(req(p, { method: m })), 200, "exempt " + m + " " + p);
for (const [m, p] of [["POST", T], ["DELETE", T], ["GET", "/imessage"], ["POST", "/s/og.png"], ["GET", "/s/other"], ["GET", "/s/" + "a".repeat(31)]] as const)
	assert.equal(await status(req(p, { method: m })), 403, "not exempt " + m + " " + p);
assert.equal(await status(req(T, { method: "POST", headers: { cookie: "CF_Authorization=" + good } })), 200, "secret POST with Access cookie ok");
assert.ok(!exempt("POST", "/s/" + "a".repeat(32) + ".json"));
// Fail closed without config; dev bypass only with DEV=1 on localhost.
assert.equal(await status(req("/box"), {}), 503);
assert.equal(await status(req("/box", {}, "http://localhost:8787"), {}), 503, "localhost alone isn't enough");
assert.equal(await status(req("/box", {}, "http://localhost:8787"), { DEV: "1" }), 200, "dev bypass");
assert.equal(await status(req("/box"), { ...env, DEV: "1" }), 403, "DEV=1 doesn't open prod host");

// Scrub, constant-time compare, secrets.
assert.equal(scrub("see https://x/s/" + "Ab-_".repeat(8) + " ok"), "see https://x/s/[link] ok");
assert.equal(scrub("/s/devin/abcdef"), "/s/devin/abcdef");
assert.ok(same("v0=abc", "v0=abc") && !same("v0=abc", "v0=abd") && !same("v0=ab", "v0=abc"));
assert.equal(ASK_TTL, 3_600_000);
assert.equal(redact({ K: "abc" }, "abc"), "abc", "short values left (they can't be stored)");
assert.equal(redact({ K: "abcd" }, "xabcdx"), "x[secret K]x");
assert.equal(MIN_LEN, 4);
const e: Record<string, string> = { A: "1234" };
Object.defineProperty(e, FAILED, { value: ["OLD_TOKEN"], enumerable: false });
assert.match(failedNote(e), /OLD_TOKEN failed to decrypt/);
assert.deepEqual(Object.keys({ ...e }), ["A"], "failed list never exported to env");
assert.equal(failedNote({ A: "x" }), "");
console.log("access tests passed");
