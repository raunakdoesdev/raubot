// Cloudflare Access, checked again inside the Worker (defense in depth: Access in front is not the only gate).
// Every request needs a valid Access JWT (RS256, team certs, aud, exp/nbf, iss) except the few public routes in `exempt`,
// which carry their own checks (Spectrum HMAC, Devin HMAC, OIDC mint key, secret-link token + Access for writes).

export type AccessEnv = { ACCESS_TEAM?: string; ACCESS_AUD?: string; DEV?: string };
/** Who a verified token belongs to: a person (email) or a service token (common_name = client id). */
export type Identity = { email?: string; service?: string; sub?: string };

type Jwk = JsonWebKey & { kid: string };
const certs = new Map<string, { keys: Map<string, CryptoKey>; at: number }>();
const TTL = 3600_000, MIN_REFRESH = 60_000, SKEW = 60;

import { unb64url } from "../core/crypto.ts";
const json = (s: string) => JSON.parse(new TextDecoder().decode(unb64url(s))) as Record<string, unknown>;

/** Team public keys, cached an hour; refetched (at most once a minute) when a kid is unknown, so key rotation just works. */
const key = async (team: string, kid: string): Promise<CryptoKey | undefined> => {
	let c = certs.get(team);
	const stale = !c || Date.now() - c.at > TTL || (!c.keys.has(kid) && Date.now() - c.at > MIN_REFRESH);
	if (stale) {
		const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
		if (!r.ok) { if (!c) return undefined; } else {
			const { keys } = (await r.json()) as { keys: Jwk[] };
			const m = new Map<string, CryptoKey>();
			for (const k of keys ?? []) if (k.kty === "RSA" && k.kid) m.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
			certs.set(team, (c = { keys: m, at: Date.now() }));
		}
	}
	return c!.keys.get(kid);
};

/** Verifies an Access JWT; the reason on failure is for logs only. */
export const verify = async (token: string, team: string, aud: string): Promise<{ ok: true; id: Identity } | { ok: false; why: string }> => {
	const parts = token.split(".");
	if (parts.length !== 3) return { ok: false, why: "malformed" };
	let h: Record<string, unknown>, p: Record<string, unknown>;
	try { h = json(parts[0]); p = json(parts[1]); } catch { return { ok: false, why: "malformed" }; }
	if (h.alg !== "RS256" || typeof h.kid !== "string") return { ok: false, why: "alg" };
	const k = await key(team, h.kid);
	if (!k) return { ok: false, why: "unknown kid" };
	let good = false;
	try { good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, unb64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1])); } catch { good = false; }
	if (!good) return { ok: false, why: "signature" };
	const auds = Array.isArray(p.aud) ? p.aud : [p.aud];
	if (!auds.includes(aud)) return { ok: false, why: "aud" };
	const now = Date.now() / 1000;
	if (typeof p.exp !== "number" || p.exp + SKEW < now) return { ok: false, why: "expired" };
	if (typeof p.nbf === "number" && p.nbf - SKEW > now) return { ok: false, why: "nbf" };
	if (String(p.iss ?? "").replace(/\/$/, "") !== `https://${team}.cloudflareaccess.com`) return { ok: false, why: "iss" };
	const email = typeof p.email === "string" && p.email ? p.email : undefined;
	const service = typeof p.common_name === "string" && p.common_name ? p.common_name : undefined;
	if (!email && !service) return { ok: false, why: "no identity" };
	return { ok: true, id: { email, service, sub: typeof p.sub === "string" ? p.sub : undefined } };
};

/** The token Access sent: the header on Access-protected paths, else the CF_Authorization cookie (bypassed paths get no header). */
export const tokenOf = (req: Request) => {
	const h = req.headers.get("cf-access-jwt-assertion");
	if (h) return h;
	const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get("cookie") ?? "");
	return m?.[1];
};

/** Local dev only: needs DEV=1 (from .dev.vars, never deployed) and a localhost URL. */
export const dev = (url: URL, env: AccessEnv) => env.DEV === "1" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);

/** The verified identity, or undefined. Fails closed if the Worker isn't configured. */
export const identity = async (req: Request, env: AccessEnv): Promise<Identity | undefined> => {
	const url = new URL(req.url);
	if (dev(url, env)) return { email: "dev@localhost" };
	const t = tokenOf(req);
	if (!t || !env.ACCESS_TEAM || !env.ACCESS_AUD) return undefined;
	const r = await verify(t, env.ACCESS_TEAM, env.ACCESS_AUD);
	if (!r.ok) console.warn("access denied", JSON.stringify({ path: scrub(url.pathname), why: r.why }));
	return r.ok ? r.id : undefined;
};

/** Secret-link tokens in paths, masked for logs and traces. */
export const scrub = (s: string) => s.replace(/\/s\/[\w-]{32}(?![\w-])/g, "/s/[link]");

const SECRET_LINK = /^\/s\/[\w-]{32}(\.json)?$/;
/** Public routes (Access bypasses /imessage and /s/*); each has its own check further in. Writes to secret links are NOT here. */
export const exempt = (method: string, path: string) => {
	if (path === "/imessage") return method === "POST";
	if (/^\/s\/devin\/[\w-]{6,64}$/.test(path)) return true; // HMAC-signed, POST only (else 405)
	if (path.startsWith("/s/oidc/")) return true; // public JWKS/discovery; minting needs OIDC_MINT_KEY
	if (path === "/s/og.png" || path === "/s/favicon.png" || path === "/s/apple-touch-icon.png" || path.startsWith("/s/assets/")) return method === "GET" || method === "HEAD";
	if (SECRET_LINK.test(path)) return method === "GET" || method === "HEAD"; // the form page + its ask; no side effects
	return false;
};

/** Default-deny gate in front of everything: a Response to return (403/503), or undefined to go on. */
export const gate = async (req: Request, env: AccessEnv): Promise<Response | undefined> => {
	const url = new URL(req.url);
	if (exempt(req.method, url.pathname)) return undefined;
	if (!dev(url, env) && (!env.ACCESS_TEAM || !env.ACCESS_AUD)) return new Response("Access not configured", { status: 503 });
	return (await identity(req, env)) ? undefined : new Response("forbidden", { status: 403, headers: { "cache-control": "no-store" } });
};
