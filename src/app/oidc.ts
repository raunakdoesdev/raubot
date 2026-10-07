// raubot as an OIDC issuer for Reducto Access agent login (product apps/internal-gate agent-auth.ts).
// Public: /s/oidc/.well-known/{openid-configuration,jwks.json}. Private: POST /s/oidc/token, bearer OIDC_MINT_KEY (only the box holds it).
// The RSA private key lives only in the OIDC_PRIVATE_JWK Worker secret.

export type OidcEnv = { PUBLIC_URL?: string; OIDC_PRIVATE_JWK?: string; OIDC_MINT_KEY?: string };

export const ISSUER_PATH = "/s/oidc";
export const REQUESTER = "raunak@reducto.ai";
export const TENANT = "raubot-reducto";
export const TTL = 60;
// Only Reducto hosts (optionally host/route/id for dynamic apps), so a leaked mint key can't target other sites.
const AUDIENCE = /^([a-z0-9-]+\.)*reducto\.ai(\/[\w.-]+){0,2}$/;

const b64url = (b: ArrayBuffer | Uint8Array) => {
	const u = b instanceof Uint8Array ? b : new Uint8Array(b);
	let s = "";
	for (const c of u) s += String.fromCharCode(c);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));

type Jwk = JsonWebKey & { kid: string };
export const publicJwk = (p: Jwk) => ({ kty: "RSA", n: p.n!, e: p.e!, kid: p.kid, alg: "RS256", use: "sig" });

/** Constant-time string compare. */
export const same = (a: string, b: string) => {
	const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
	let d = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return d === 0;
};

export const validAudience = (aud: string) => AUDIENCE.test(aud);

/** A signed RS256 token: iss, aud, sub, sid, email, tenant, iat, nbf, exp (+60s), jti. */
export const mint = async (jwk: Jwk, issuer: string, aud: string, now = Math.floor(Date.now() / 1000)) => {
	const key = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const sid = "raubot-" + crypto.randomUUID();
	const body = { iss: issuer, aud, sub: sid, sid, email: REQUESTER, tenant: TENANT, iat: now, nbf: now - 5, exp: now + TTL, jti: crypto.randomUUID() };
	const input = enc({ alg: "RS256", typ: "JWT", kid: jwk.kid }) + "." + enc(body);
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
	return input + "." + b64url(sig);
};

const json = (o: unknown, status = 200, cache = "no-store") => Response.json(o, { status, headers: { "cache-control": cache } });

/** Handles /s/oidc/*, or undefined for other paths. */
export const oidc = async (req: Request, env: OidcEnv): Promise<Response | undefined> => {
	const url = new URL(req.url);
	if (!url.pathname.startsWith(ISSUER_PATH + "/")) return undefined;
	const issuer = (env.PUBLIC_URL ?? url.origin) + ISSUER_PATH;
	if (!env.OIDC_PRIVATE_JWK) return json({ error: "issuer not configured" }, 503);
	const jwk = JSON.parse(env.OIDC_PRIVATE_JWK) as Jwk;
	const sub = url.pathname.slice(ISSUER_PATH.length);
	if (sub === "/.well-known/jwks.json" && req.method === "GET") return json({ keys: [publicJwk(jwk)] }, 200, "public, max-age=300");
	if (sub === "/.well-known/openid-configuration" && req.method === "GET")
		return json({ issuer, jwks_uri: issuer + "/.well-known/jwks.json", id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["id_token"], subject_types_supported: ["public"], claims_supported: ["sid", "email", "tenant"] }, 200, "public, max-age=300");
	if (sub === "/token" && req.method === "POST") {
		const auth = req.headers.get("authorization") ?? "";
		if (!env.OIDC_MINT_KEY || !same(auth, "Bearer " + env.OIDC_MINT_KEY)) return json({ error: "unauthorized" }, 401);
		const aud = (url.searchParams.get("audience") ?? "").trim().toLowerCase();
		if (!validAudience(aud)) return json({ error: "audience must be a reducto.ai host (optionally host/route/id)" }, 400);
		return json({ token: await mint(jwk, issuer, aud), expires_in: TTL });
	}
	return json({ error: "not found" }, 404);
};
