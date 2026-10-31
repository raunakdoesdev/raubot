// One-tap pairing for the iOS app. raubot mints a single-use code (POST /api/pair/new, behind Access + app token);
// the phone redeems it (POST /api/pair/redeem, public: Access bypasses exactly that path) for the creds it would
// otherwise paste: the Access service token and the app token. Only a code's SHA-256 is stored.

export const TTL_MS = 10 * 60_000;
export const RATE = { max: 10, windowMs: 60_000 };
const CODE = /^[A-Za-z0-9_-]{43}$/;

export type Creds = { base_url: string; cf_access_client_id: string; cf_access_client_secret: string; app_token: string };
export type PairEnv = { PUBLIC_URL: string; PAIR_CF_CLIENT_ID?: string; PAIR_CF_CLIENT_SECRET?: string; TODOS_APP_TOKEN?: string };
/** What a redeem attempt comes to, before any HTTP. */
export type Redeem = { ok: true; creds: Creds } | { ok: false; status: 400 | 410 | 429 | 503; error: string };

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hash = async (code: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))));

export const link = (base: string, code: string) => `raubot://pair?base=${encodeURIComponent(base)}&code=${code}`;

export class Pairing {
	#sql: SqlStorage;
	#hits = new Map<string, number[]>();
	constructor(sql: SqlStorage) {
		this.#sql = sql;
		sql.exec("CREATE TABLE IF NOT EXISTS pair_codes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER, device_name TEXT)");
	}

	/** A fresh 256-bit code; expired rows are swept on the way. */
	async mint(now = Date.now()) {
		this.#sql.exec("DELETE FROM pair_codes WHERE expires_at < ?", now - 86_400_000);
		const code = b64url(crypto.getRandomValues(new Uint8Array(32)));
		this.#sql.exec("INSERT INTO pair_codes (hash, expires_at) VALUES (?, ?)", await hash(code), now + TTL_MS);
		return code;
	}

	/** Sliding-window limit per client IP. */
	limited(ip: string, now = Date.now()) {
		const recent = (this.#hits.get(ip) ?? []).filter((t) => now - t < RATE.windowMs);
		recent.push(now);
		this.#hits.set(ip, recent);
		return recent.length > RATE.max;
	}

	async redeem(raw: unknown, ip: string, env: PairEnv, now = Date.now()): Promise<Redeem> {
		if (this.limited(ip, now)) return { ok: false, status: 429, error: "too many attempts" };
		const { code, device_name } = (raw && typeof raw === "object" ? raw : {}) as { code?: unknown; device_name?: unknown };
		if (typeof code !== "string" || !CODE.test(code)) return { ok: false, status: 400, error: "bad code" };
		const h = await hash(code);
		const row = this.#sql.exec("SELECT expires_at, used_at FROM pair_codes WHERE hash = ?", h).toArray()[0] as { expires_at: number; used_at: number | null } | undefined;
		if (!row) return { ok: false, status: 400, error: "bad code" };
		if (row.used_at != null || row.expires_at < now) return { ok: false, status: 410, error: row.used_at != null ? "code already used" : "code expired" };
		if (!env.PAIR_CF_CLIENT_ID || !env.PAIR_CF_CLIENT_SECRET || !env.TODOS_APP_TOKEN) return { ok: false, status: 503, error: "pairing not configured" };
		const name = typeof device_name === "string" ? device_name.slice(0, 100) : null;
		this.#sql.exec("UPDATE pair_codes SET used_at = ?, device_name = ? WHERE hash = ? AND used_at IS NULL", now, name, h);
		return { ok: true, creds: { base_url: env.PUBLIC_URL, cf_access_client_id: env.PAIR_CF_CLIENT_ID, cf_access_client_secret: env.PAIR_CF_CLIENT_SECRET, app_token: env.TODOS_APP_TOKEN } };
	}
}

const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "cache-control": "no-store" } });

/** POST /api/pair/new and POST /api/pair/redeem. */
export const http = async (p: Pairing, env: PairEnv, req: Request): Promise<Response> => {
	const path = new URL(req.url).pathname;
	if (req.method !== "POST") return json({ error: "POST only" }, 405);
	if (path === "/api/pair/new") {
		const code = await p.mint();
		return json({ link: link(env.PUBLIC_URL, code), expires_in: TTL_MS / 1000 });
	}
	const body = await req.json().catch(() => undefined);
	const r = await p.redeem(body, req.headers.get("cf-connecting-ip") ?? "unknown", env);
	if (r.ok) console.log("pair redeemed", JSON.stringify({ device: String((body as { device_name?: unknown }).device_name ?? "").slice(0, 100) }));
	return r.ok ? json(r.creds) : json({ error: r.error }, r.status);
};
