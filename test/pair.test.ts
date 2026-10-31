import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { http, link, Pairing, RATE, TTL_MS } from "../src/core/pair.ts";
import { exempt, appToken } from "../src/app/access.ts";

const db = new DatabaseSync(":memory:");
const sql = { exec: (q: string, ...a: unknown[]) => { const s = db.prepare(q); return /^\s*select/i.test(q) ? { toArray: () => s.all(...(a as never[])) } : (s.run(...(a as never[])), { toArray: () => [] }); } } as unknown as SqlStorage;
const env = { PUBLIC_URL: "https://raubot-staging.example.com", PAIR_CF_CLIENT_ID: "id.access", PAIR_CF_CLIENT_SECRET: "sec", TODOS_APP_TOKEN: "app" };
const p = new Pairing(sql);
const post = (path: string, body?: unknown, ip = "1.1.1.1") => http(p, env, new Request("https://x" + path, { method: "POST", headers: { "cf-connecting-ip": ip }, body: body === undefined ? undefined : JSON.stringify(body) }));

const minted = (await (await post("/api/pair/new")).json()) as { link: string };
const u = new URL(minted.link);
assert.equal(u.protocol, "raubot:");
assert.equal(new URLSearchParams(minted.link.split("?")[1]).get("base"), env.PUBLIC_URL, "link carries base url");
const code = new URLSearchParams(minted.link.split("?")[1]).get("code")!;
assert.equal(code.length, 43, "256-bit code");
assert.ok(!JSON.stringify(db.prepare("SELECT * FROM pair_codes").all()).includes(code), "code stored only hashed");

const ok = await post("/api/pair/redeem", { code, device_name: "iPhone" });
assert.equal(ok.status, 200);
assert.deepEqual(await ok.json(), { base_url: env.PUBLIC_URL, cf_access_client_id: "id.access", cf_access_client_secret: "sec", app_token: "app" });
assert.equal((await post("/api/pair/redeem", { code })).status, 410, "single use");
assert.equal((await post("/api/pair/redeem", { code: "A".repeat(43) })).status, 400, "unknown code");
assert.equal((await post("/api/pair/redeem", { code: "short" })).status, 400, "malformed code");
assert.equal((await post("/api/pair/redeem")).status, 400, "no body");

const c2 = await p.mint(Date.now() - TTL_MS - 1);
assert.deepEqual(await p.redeem({ code: c2 }, "2.2.2.2", env), { ok: false, status: 410, error: "code expired" });

const c3 = await p.mint();
assert.equal((await p.redeem({ code: c3 }, "3.3.3.3", { PUBLIC_URL: env.PUBLIC_URL }) as { status: number }).status, 503, "fails closed without secrets");
assert.equal((await p.redeem({ code: c3 }, "3.3.3.4", env)).ok, true, "unconfigured attempt does not burn the code");

for (let i = 0; i < RATE.max; i++) await post("/api/pair/redeem", { code: "x" }, "9.9.9.9");
assert.equal((await post("/api/pair/redeem", { code: "x" }, "9.9.9.9")).status, 429, "rate limited per ip");
assert.equal((await post("/api/pair/redeem", { code: "x" }, "8.8.8.8")).status, 400, "other ips unaffected");
assert.equal((await http(p, env, new Request("https://x/api/pair/redeem"))).status, 405);

assert.equal(exempt("POST", "/api/pair/redeem"), true, "redeem is public");
assert.equal(exempt("GET", "/api/pair/redeem"), false);
assert.equal(exempt("POST", "/api/pair/new"), false, "mint stays behind Access");
const tok = (h?: string) => appToken(new Request("https://x/api/pair/new", { headers: h ? { authorization: h } : {} }), "/api/pair/new", { TODOS_APP_TOKEN: "app" });
assert.equal(tok()?.status, 401, "mint needs the app token too");
assert.equal(tok("Bearer app"), undefined);
console.log("pair ok");
