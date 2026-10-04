/** OAuth 2.1 client for an MCP server: dynamic registration + PKCE, tokens kept in DO storage and refreshed on demand. */
type Tokens = { access: string; refresh?: string; expires: number };
type Meta = { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));

export class OAuth {
	constructor(readonly storage: DurableObjectStorage, readonly resource: string) {}

	async #meta(): Promise<Meta> {
		const u = new URL(this.resource);
		const pr = await (await fetch(`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`)).json() as { authorization_servers: string[] };
		const as = new URL(pr.authorization_servers[0]!);
		return (await fetch(`${as.origin}/.well-known/oauth-authorization-server${as.pathname === "/" ? "" : as.pathname}`)).json();
	}

	async start(origin: string) {
		const meta = await this.#meta();
		const redirect = `${origin}/oauth/callback`;
		let client = await this.storage.get<{ id: string; redirect: string }>("oauth-client");
		if (client?.redirect !== redirect) {
			const r = await fetch(meta.registration_endpoint, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ client_name: "raubot", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
			});
			if (!r.ok) throw new Error(`register: ${r.status} ${await r.text()}`);
			client = { id: ((await r.json()) as { client_id: string }).client_id, redirect };
			await this.storage.put("oauth-client", client);
		}
		const verifier = random(), state = random();
		await this.storage.put("oauth-pending", { verifier, state });
		const q = new URLSearchParams({
			response_type: "code", client_id: client.id, redirect_uri: redirect, scope: "mcp offline_access", state, resource: this.resource,
			code_challenge: b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))), code_challenge_method: "S256",
		});
		return `${meta.authorization_endpoint}?${q}`;
	}

	async #grant(body: Record<string, string>) {
		const client = (await this.storage.get<{ id: string }>("oauth-client"))!;
		const r = await fetch((await this.#meta()).token_endpoint, {
			method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ ...body, client_id: client.id, resource: this.resource }),
		});
		if (!r.ok) throw new Error(`token: ${r.status} ${await r.text()}`);
		const t = (await r.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
		const prev = await this.storage.get<Tokens>("oauth-tokens");
		const tokens = { access: t.access_token, refresh: t.refresh_token ?? prev?.refresh, expires: Date.now() + (t.expires_in ?? 3600) * 1000 };
		await this.storage.put("oauth-tokens", tokens);
		return tokens;
	}

	async callback(q: URLSearchParams) {
		const p = await this.storage.get<{ verifier: string; state: string }>("oauth-pending");
		if (!p || q.get("state") !== p.state) throw new Error("bad state");
		if (q.get("error")) throw new Error(q.get("error_description") ?? q.get("error")!);
		await this.storage.delete("oauth-pending");
		const client = (await this.storage.get<{ redirect: string }>("oauth-client"))!;
		await this.#grant({ grant_type: "authorization_code", code: q.get("code")!, redirect_uri: client.redirect, code_verifier: p.verifier });
	}

	async connected() { return !!(await this.storage.get("oauth-tokens")); }

	/** A valid access token; refreshes when within a minute of expiry or when forced after a 401. */
	async token(force = false) {
		const t = await this.storage.get<Tokens>("oauth-tokens");
		if (!t) throw new Error("Executor is not connected; ask the user to open /oauth/start");
		if (!force && t.expires > Date.now() + 60_000) return t.access;
		if (!t.refresh) throw new Error("Executor session expired; ask the user to reconnect at /oauth/start");
		return (await this.#grant({ grant_type: "refresh_token", refresh_token: t.refresh })).access;
	}
}
