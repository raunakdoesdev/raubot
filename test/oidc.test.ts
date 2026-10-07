import assert from "node:assert/strict";
import { oidc, publicJwk, validAudience, same } from "../src/app/oidc.ts";

const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const priv = { ...(await crypto.subtle.exportKey("jwk", kp.privateKey)), kid: "test-kid" };
const env = { PUBLIC_URL: "https://raubot.reducto.ai", OIDC_PRIVATE_JWK: JSON.stringify(priv), OIDC_MINT_KEY: "mint-secret" };
const call = (path: string, init?: RequestInit) => oidc(new Request("https://raubot.reducto.ai" + path, init), env);
const dec = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString());

// Public docs.
const jwks = (await (await call("/s/oidc/.well-known/jwks.json"))!.json()) as { keys: Record<string, string>[] };
assert.equal(jwks.keys.length, 1);
assert.equal(jwks.keys[0].kid, "test-kid");
assert.equal(jwks.keys[0].d, undefined, "no private parts in JWKS");
assert.deepEqual(Object.keys(jwks.keys[0]).sort(), ["alg", "e", "kid", "kty", "n", "use"]);
const conf = (await (await call("/s/oidc/.well-known/openid-configuration"))!.json()) as Record<string, string>;
assert.equal(conf.issuer, "https://raubot.reducto.ai/s/oidc");
assert.equal(conf.jwks_uri, "https://raubot.reducto.ai/s/oidc/.well-known/jwks.json");

// Minting is gated.
assert.equal((await call("/s/oidc/token?audience=agents.reducto.ai", { method: "POST" }))!.status, 401);
assert.equal((await call("/s/oidc/token?audience=agents.reducto.ai", { method: "POST", headers: { authorization: "Bearer wrong" } }))!.status, 401);
assert.equal((await call("/s/oidc/token?audience=agents.reducto.ai"))!.status, 404, "GET does not mint");
assert.equal((await call("/s/oidc/token?audience=evil.com", { method: "POST", headers: { authorization: "Bearer mint-secret" } }))!.status, 400);

// A good token verifies against the JWKS.
const r = await call("/s/oidc/token?audience=agents.reducto.ai", { method: "POST", headers: { authorization: "Bearer mint-secret" } });
assert.equal(r!.status, 200);
const { token, expires_in } = (await r!.json()) as { token: string; expires_in: number };
assert.equal(expires_in, 60);
const [h, p, s] = token.split(".");
assert.deepEqual(dec(h), { alg: "RS256", typ: "JWT", kid: "test-kid" });
const c = dec(p);
assert.equal(c.iss, "https://raubot.reducto.ai/s/oidc");
assert.equal(c.aud, "agents.reducto.ai");
assert.equal(c.email, "raunak@reducto.ai");
assert.equal(c.tenant, "raubot-reducto");
assert.match(c.sid, /^raubot-/);
assert.equal(c.exp - c.iat, 60);
assert.ok(c.nbf <= c.iat && c.jti);
const pub = await crypto.subtle.importKey("jwk", publicJwk(priv), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, Buffer.from(s, "base64url"), new TextEncoder().encode(h + "." + p)));

assert.ok(validAudience("apps.reducto.ai/internal/tool"));
assert.ok(!validAudience("reducto.ai.evil.com"));
assert.ok(same("a", "a") && !same("a", "ab"));
assert.equal(await oidc(new Request("https://raubot.reducto.ai/s/other"), env), undefined);
console.log("oidc ok");
