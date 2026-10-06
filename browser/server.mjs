// The box's browser: one persistent Chromium (profile in ~/.raubot/browser, outside git) driven by JS sent over a unix socket.
// Started on demand by cli.mjs; restarted by it when this code changes.
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";
import * as vault from "./vault.mjs";
import { attach } from "./passkeys.mjs";

export const SOCK = "/tmp/raubot-browser.sock";
const DIR = `${process.env.HOME}/.raubot`;
const VIEWPORT = { width: 1440, height: 900 };

let ctx, page, env = {}, keys;
const tabs = new Map(); // page -> authenticator
const state = {};
const used = new Map(); // value -> ref, scrubbed from output

// Every tab has its own authenticator, so a use in one tab is copied to the others; vault saves run one at a time.
let saving = Promise.resolve();
async function onUse(p, n, from) {
	p.counter = String(n);
	console.log(new Date().toISOString(), "passkey used", p.rpId, n);
	for (const a of tabs.values()) if (a !== from) await a.set(keys).catch(() => {});
	saving = saving.then(() => vault.counted(env, p.credentialId, n)).catch((e) => console.error("counter", e.message));
}

async function arm(p) {
	const a = await attach(p, (k, n) => onUse(k, n, a)).catch((e) => console.error("webauthn", e.message));
	if (!a) return;
	tabs.set(p, a);
	p.on("close", () => tabs.delete(p));
	if (keys) await a.set(keys);
}

/** Loads (or with `fresh`, reloads) the vault's passkeys into every tab. */
async function loadKeys(fresh = false) {
	if (!vault.ready(env) || (keys && !fresh)) return;
	keys = await vault.passkeys(env);
	for (const a of tabs.values()) await a.set(keys);
}

async function browser() {
	if (ctx) return ctx;
	fs.mkdirSync(`${DIR}/browser`, { recursive: true });
	// A box copied from a snapshot keeps the original box's Chromium locks; this server is the profile's only user.
	for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) fs.rmSync(`${DIR}/browser/${f}`, { force: true });
	ctx = await chromium.launchPersistentContext(`${DIR}/browser`, {
		channel: "chromium", headless: true, viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: true, ...(fs.existsSync("/workspace") ? { downloadsPath: "/workspace/uploads/downloads" } : {}),
		args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
	});
	ctx.on("page", (p) => { page = p; void arm(p); });
	ctx.on("close", () => { ctx = undefined; tabs.clear(); });
	for (const p of ctx.pages()) await arm(p);
	page = ctx.pages()[0] ?? (await ctx.newPage());
	return ctx;
}

// Logins shared across boxes: before a run, cookies another box changed come in; after it, the domains changed here go out.
// `base` is the jar as this box last synced it, so a cookie a site refreshed here between runs is never rolled back to the jar's older copy.
let base = new Map();
const byDomain = (cs) => { const m = new Map(); for (const c of cs) m.set(c.domain, [...(m.get(c.domain) ?? []), c]); return m; };
const key = (cs = []) => JSON.stringify(cs.map(({ name, value, path }) => [name, value, path]).sort());
async function share(jar = {}) {
	const have = byDomain(await ctx.cookies());
	for (const [d, cs] of Object.entries(jar)) {
		if (key(base.get(d)) === key(cs) || key(have.get(d)) === key(cs)) continue;
		await ctx.clearCookies({ domain: d });
		await ctx.addCookies(cs);
	}
	base = new Map([...base, ...Object.entries(jar)]);
}
async function changed() {
	const now = byDomain(await ctx.cookies());
	const out = {};
	for (const d of new Set([...base.keys(), ...now.keys()])) if (key(base.get(d)) !== key(now.get(d))) out[d] = now.get(d) ?? [];
	base = now;
	return out;
}

const remember = (ref, v) => { if (v.length >= 4) used.set(v, ref); return v; };
const scrub = (s) => { for (const [v, ref] of used) s = s.split(v).join(`[${ref}]`); return s; };
const show = (v) => (typeof v === "string" ? v : (() => { try { return JSON.stringify(v, null, 1); } catch { return String(v); } })());

async function run({ code, timeout = 60, jar }) {
	await browser();
	await share(jar).catch((e) => console.error("jar", e.message));
	await loadKeys().catch((e) => console.error("passkeys", e.message));
	if (page.isClosed()) page = ctx.pages().at(-1) ?? (await ctx.newPage());
	const out = [], images = [];
	const log = (...a) => out.push(a.map(show).join(" "));
	const screenshot = async (opts = {}) => { images.push((await (opts.page ?? page).screenshot({ type: "jpeg", quality: 80, ...opts, page: undefined })).toString("base64")); };
	const target = (t) => (typeof t === "string" ? page.locator(t) : t);
	const v = {
		find: (...words) => vault.find(env, words.flat()),
		fill: async (t, ref) => target(t).fill(remember(ref, await vault.resolve(env, ref))),
		type: async (ref, opts) => page.keyboard.type(remember(ref, await vault.resolve(env, ref)), { delay: 40, ...opts }),
		sync: async () => { vault.refresh(); await loadKeys(true); return `${keys?.length ?? 0} passkeys loaded`; },
	};
	const fn = new (Object.getPrototypeOf(async () => {}).constructor)("page", "context", "state", "vault", "screenshot", "console", "sleep", code);
	let error;
	try {
		const ret = await Promise.race([
			fn(page, ctx, state, v, screenshot, { log, info: log, warn: log, error: log }, (ms) => new Promise((r) => setTimeout(r, ms))),
			new Promise((_, no) => setTimeout(() => no(new Error(`timed out after ${timeout}s`)), timeout * 1000)),
		]);
		if (ret !== undefined) log(ret);
	} catch (e) { error = true; log(`Error: ${e?.message ?? e}`); }
	if (page.isClosed()) page = ctx.pages().at(-1) ?? (await ctx.newPage());
	if (!images.length) await screenshot().catch(() => {});
	const all = await Promise.all(ctx.pages().map(async (p, i) => `${p === page ? "*" : " "}${i} ${await p.title().catch(() => "")} ${p.url()}`));
	return { out: scrub(out.join("\n")), error, images, tabs: all.join("\n"), changed: await changed().catch(() => ({})) };
}

let chain = Promise.resolve();
const serial = (f) => (chain = chain.then(f, f));

const ops = {
	run: (b) => serial(() => run(b)),
	find: (b) => vault.find(env, b.words),
	resolve: async (b) => Object.fromEntries(await Promise.all(Object.entries(b.refs).map(async ([k, ref]) => [k, await vault.resolve(env, ref)]))),
	quit: async () => { setTimeout(async () => { await ctx?.close().catch(() => {}); process.exit(0); }, 50); return "bye"; },
	version: async () => VERSION,
};

const VERSION = ["server.mjs", "vault.mjs", "passkeys.mjs"].map((f) => fs.statSync(new URL(f, import.meta.url)).mtimeMs).join(":");

fs.rmSync(SOCK, { force: true });
http.createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	try {
		const b = JSON.parse(body || "{}");
		if (b.env) env = b.env;
		res.end(JSON.stringify({ ok: await ops[req.url.slice(1)](b) }));
	} catch (e) { res.end(JSON.stringify({ error: scrub(String(e?.message ?? e)) })); }
}).listen(SOCK);

// The app's live view polls this through the box: the current tab as a JPEG, 204 before the browser starts.
http.createServer(async (req, res) => {
	const jpeg = ctx && page && !page.isClosed() ? await page.screenshot({ type: "jpeg", quality: 60, timeout: 5000 }).catch(() => undefined) : undefined;
	if (!jpeg) return res.writeHead(204).end();
	res.writeHead(200, { "content-type": "image/jpeg", "x-url": encodeURI(page.url()) }).end(jpeg);
}).listen(8090, "0.0.0.0");
