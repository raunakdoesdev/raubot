// Bitwarden through the official `bw` CLI, 2password-style: refs and metadata out, values only to whoever uses them.
// Refs: bw://<item name or id>[/<field>], field one of username, password (default), totp, notes, uri, or a custom field's name.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const BW = process.env.BW_BIN ?? new URL("./node_modules/.bin/bw", import.meta.url).pathname;
const NEED = ["BW_CLIENTID", "BW_CLIENTSECRET", "BW_PASSWORD"];

let session, items, synced = 0;

const bw = async (args, env = {}) => (await run(BW, args, { env: { ...process.env, BITWARDENCLI_APPDATA_DIR: `${process.env.HOME}/.raubot/bw`, BW_NOINTERACTION: "true", ...(session ? { BW_SESSION: session } : {}), ...env }, maxBuffer: 256 << 20 })).stdout;

async function unlock(env) {
	if (session) return;
	const missing = NEED.filter((k) => !env[k]);
	if (missing.length) throw new Error(`Bitwarden isn't set up: missing ${missing.join(", ")}. Ask the user for them with tools.secrets (BW_CLIENTID / BW_CLIENTSECRET are the personal API key from bitwarden.com > Settings > Security > Keys; BW_PASSWORD is the master password).`);
	const status = JSON.parse(await bw(["status"])).status;
	if (status === "unauthenticated") await bw(["login", "--apikey"], env);
	session = (await bw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], env)).trim();
}

/** Every item, decrypted, cached for a minute. */
async function all(env, fresh = false) {
	await unlock(env);
	if (fresh || !items || Date.now() - synced > 60_000) {
		await bw(["sync"]);
		items = JSON.parse(await bw(["list", "items"]));
		synced = Date.now();
	}
	return items;
}

const has = (i) => [i.login?.username && "username", i.login?.password && "password", i.login?.totp && "totp", i.login?.fido2Credentials?.length && "passkey", i.notes && "notes", ...(i.fields ?? []).map((f) => `field:${f.name}`)].filter(Boolean);

/** Metadata only, never values. */
export async function find(env, words) {
	const list = await all(env);
	const named = new Map();
	for (const i of list) named.set(i.name, (named.get(i.name) ?? 0) + 1);
	const hay = (i) => [i.name, i.login?.username, ...(i.login?.uris ?? []).map((u) => u.uri), ...(i.login?.fido2Credentials ?? []).map((p) => p.rpId)].filter(Boolean).join(" ").toLowerCase();
	return list.filter((i) => words.every((w) => hay(i).includes(w.toLowerCase()))).slice(0, 50).map((i) => ({
		ref: `bw://${named.get(i.name) > 1 || i.name.includes("/") ? i.id : i.name}`, id: i.id, name: i.name, folder: i.folderId ?? undefined,
		username: i.login?.username ?? undefined, uris: (i.login?.uris ?? []).map((u) => u.uri), passkeys: (i.login?.fido2Credentials ?? []).map((p) => p.rpId), has: has(i),
	}));
}

/** The value a ref points to. */
export async function resolve(env, ref) {
	const m = /^bw:\/\/([^/]+)(?:\/(.+))?$/.exec(ref);
	if (!m) throw new Error(`bad ref ${ref}: use bw://<item>/<field>`);
	const [, key, field = "password"] = m;
	let list = await all(env);
	let hits = list.filter((i) => i.id === key || i.name === key);
	if (!hits.length) hits = (list = await all(env, true)).filter((i) => i.id === key || i.name === key);
	if (hits.length !== 1) throw new Error(`${ref}: ${hits.length ? "several items have that name, use its id" : "no such item"} (try vault find)`);
	const i = hits[0];
	const v = field === "totp" ? i.login?.totp && (await bw(["get", "totp", i.id])).trim()
		: field === "uri" ? i.login?.uris?.[0]?.uri
		: field === "notes" ? i.notes
		: ["username", "password"].includes(field) ? i.login?.[field]
		: i.fields?.find((f) => f.name === field)?.value;
	if (!v) throw new Error(`${ref}: item has no ${field}`);
	return v;
}

/** Every passkey in the vault, as stored (login.fido2Credentials). */
export async function passkeys(env) {
	return (await all(env)).flatMap((i) => i.login?.fido2Credentials ?? []);
}

/** Saves a passkey's sign counter back to its item, as Bitwarden's own clients do, so every client keeps counting up from it. */
export async function counted(env, credentialId, count) {
	const item = (await all(env)).find((i) => i.login?.fido2Credentials?.some((p) => p.credentialId === credentialId));
	if (!item) return;
	const fresh = JSON.parse(await bw(["get", "item", item.id]));
	for (const p of fresh.login.fido2Credentials) if (p.credentialId === credentialId && Number(p.counter) < count) p.counter = String(count);
	await edit(item.id, Buffer.from(JSON.stringify(fresh)).toString("base64"));
	items = undefined;
}

// `bw edit item <id>` reads the encoded item from stdin, keeping it out of argv.
const edit = (id, encoded) => new Promise((ok, fail) => {
	const p = execFile(BW, ["edit", "item", id], { env: { ...process.env, BITWARDENCLI_APPDATA_DIR: `${process.env.HOME}/.raubot/bw`, BW_NOINTERACTION: "true", BW_SESSION: session } }, (e) => (e ? fail(e) : ok()));
	p.stdin.end(encoded);
});

/** Forget the cached items so the next use syncs. */
export const refresh = () => { items = undefined; };

export const ready = (env) => NEED.every((k) => env[k]);
