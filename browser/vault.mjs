// Bitwarden through the official `bw` CLI, 2password-style: refs and metadata out, values only to whoever uses them.
// Refs: bw://<item name or id>[/<field>] for any item kind (login, secure note, card, identity). Fields: username, password (default; a note's text for secure notes), totp, notes, uri, card/number|exp|code|..., identity fields, or a custom field's name. No website/URI gate: a ref named explicitly by the agent resolves wherever it is used.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { blockReason, blockedFolderIds, Blocked, FOLDER } from "./blocklist.mjs";

const run = promisify(execFile);
const BW = process.env.BW_BIN ?? new URL("./node_modules/.bin/bw", import.meta.url).pathname;
const NEED = ["BW_CLIENTID", "BW_CLIENTSECRET", "BW_PASSWORD"];
// The red-team fake vault (box/boat/redteam/bw), picked per call by the BW_BIN secret. No other path is accepted from a secret.
const FAKE = new URL("../box/boat/redteam/bw", import.meta.url).pathname;
const fake = (env) => env?.BW_BIN === FAKE;
const bin = (env) => (fake(env) ? FAKE : BW);

// On a Boat box this is tmpfs (RAUBOT_BW_DIR=/dev/shm/raubot-bw), so Bitwarden's login and cache never reach the disk or its snapshots.
const DATA = process.env.RAUBOT_BW_DIR ?? `${process.env.HOME}/.raubot/bw`;

let session, items, blocked, synced = 0;

const raw = async (args, env = {}) => (await run(bin(env), args, { env: { ...process.env, BITWARDENCLI_APPDATA_DIR: DATA, BW_NOINTERACTION: "true", ...(session ? { BW_SESSION: session } : {}), ...env }, maxBuffer: 256 << 20 })).stdout;

// The server is long-lived: its cached BW_SESSION goes stale when the vault gets locked or logged out under it
// (another unlock or lock, a wiped tmpfs data dir, a restored box snapshot, an expired login). Bitwarden then answers
// "Vault is locked" / "You are not logged in". Drop the session, log in and unlock again, and retry once.
const STALE = /vault is locked|not logged in|unauthenticated|session key is invalid|invalid session|mac (?:comparison )?failed/i;
const SETUP = new Set(["status", "login", "unlock", "logout", "lock"]);
async function bw(args, env = {}) {
	try {
		return await raw(args, env);
	} catch (e) {
		if (SETUP.has(args[0]) || !STALE.test(`${e.stderr ?? ""} ${e.stdout ?? ""} ${e.message ?? ""}`)) throw e;
		session = undefined;
		items = blocked = undefined;
		await unlock(env);
		return await raw(args, env);
	}
}

async function unlock(env) {
	if (session) return;
	const missing = fake(env) ? [] : NEED.filter((k) => !env[k]);
	if (missing.length) throw new Error(`Bitwarden isn't set up: missing ${missing.join(", ")}. Ask the user for them with tools.secrets (BW_CLIENTID / BW_CLIENTSECRET are the personal API key from bitwarden.com > Settings > Security > Keys; BW_PASSWORD is the master password).`);
	const status = JSON.parse(await raw(["status"], env)).status;
	if (status === "unauthenticated") await raw(["login", "--apikey"], env);
	session = (await raw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], env)).trim();
	if (!session) throw new Error("Bitwarden unlock returned no session");
}

/** Every item Raunak's blocklist allows, decrypted, cached for a minute. Blocked items are dropped on read; only their id and name stay, to refuse refs to them. */
async function all(env, fresh = false) {
	await unlock(env);
	if (fresh || !items || Date.now() - synced > 60_000) {
		await bw(["sync"], env);
		const folders = blockedFolderIds(JSON.parse(await bw(["list", "folders"], env)));
		const list = JSON.parse(await bw(["list", "items"], env));
		items = list.filter((i) => !blockReason(i, folders));
		blocked = new Set(list.filter((i) => blockReason(i, folders)).flatMap((i) => [i.id, i.name]));
		synced = Date.now();
	}
	return items;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const has = (i) => [i.login?.username && "username", i.login?.password && "password", i.login?.totp && "totp", i.login?.fido2Credentials?.length && "passkey", i.notes && "notes", i.card?.number && "card:number", i.card?.expMonth && "card:expMonth", i.card?.expYear && "card:expYear", i.card?.code && "card:code", i.card?.cardholderName && "card:cardholderName", i.card?.brand && "card:brand", ...Object.entries(i.identity ?? {}).filter(([, v]) => v).map(([k]) => `identity:${k}`), ...(i.fields ?? []).map((f) => `field:${f.name}`)].filter(Boolean);
const kind = (i) => ({ 1: "login", 2: "note", 3: "card", 4: "identity" })[i.type] ?? `type${i.type}`;

/** Metadata only, never values. */
export async function find(env, words) {
	const list = await all(env);
	const named = new Map();
	for (const i of list) named.set(i.name, (named.get(i.name) ?? 0) + 1);
	const hay = (i) => [i.name, i.login?.username, i.card?.brand, i.card?.cardholderName, [i.identity?.firstName, i.identity?.lastName].filter(Boolean).join(" "), ...(i.login?.uris ?? []).map((u) => u.uri), ...(i.login?.fido2Credentials ?? []).map((p) => p.rpId)].filter(Boolean).join(" ").toLowerCase();
	return list.filter((i) => words.every((w) => hay(i).includes(w.toLowerCase()))).slice(0, 50).map((i) => ({
		ref: `bw://${named.get(i.name) > 1 || i.name.includes("/") ? i.id : i.name}`, id: i.id, name: i.name, kind: kind(i), folder: i.folderId ?? undefined,
		username: i.login?.username ?? undefined, uris: (i.login?.uris ?? []).map((u) => u.uri), passkeys: (i.login?.fido2Credentials ?? []).map((p) => p.rpId), has: has(i),
	}));
}

/** The item a ref points to and the field it names. */
async function item(env, ref) {
	const m = /^bw:\/\/([^/]+)(?:\/(.+))?$/.exec(ref);
	if (!m) throw new Error(`bad ref ${ref}: use bw://<item>/<field>`);
	const [, key, field = "password"] = m;
	let list = await all(env);
	if (blocked.has(key)) throw new Blocked(ref);
	let hits = list.filter((i) => i.id === key || i.name === key);
	if (!hits.length) hits = (list = await all(env, true)).filter((i) => i.id === key || i.name === key);
	if (blocked.has(key)) throw new Blocked(ref);
	if (hits.length !== 1) throw new Error(`${ref}: ${hits.length ? "several items have that name, use its id" : "no such item"} (try vault find)`);
	return { i: hits[0], field };
}

/** The URIs the item a ref points to is saved for. */
export const uris = async (env, ref) => ((await item(env, ref)).i.login?.uris ?? []).map((u) => u.uri).filter(Boolean);

/**
 * The value a ref points to, for every item kind, with no website/URI gate.
 * Logins: username/password/totp/uri/notes/custom-field. Secure notes: notes (default when no login password).
 * Cards: bw://Item/card/number (also number, exp=MM/YYYY, code/cvv, cardholder, brand). Identities: any field by name.
 */
export async function resolve(env, ref) {
	const { i, field } = await item(env, ref);
	const parts = field.split("/").map(norm);
	let v;
	if (parts[0] === "card" || (i.card && parts.length === 1 && ["number", "cardnumber", "exp", "expiry", "expmonth", "expyear", "code", "cvv", "cvc", "cardholder", "cardholdername", "brand"].includes(parts[0]))) {
		const k0 = parts.length > 1 ? parts.slice(1).join("") : (parts[0] === "card" ? "" : parts[0]);
		const k = { cvv: "code", cvc: "code", cardholder: "cardholdername" }[k0] ?? k0;
		v = k === "number" || k === "cardnumber" || k === "" ? i.card?.number
			: k === "exp" || k === "expiry" ? (i.card?.expMonth && i.card?.expYear ? `${String(i.card.expMonth).padStart(2, "0")}/${i.card.expYear}` : undefined)
			: Object.entries(i.card ?? {}).find(([n]) => norm(n) === k)?.[1];
	} else if (parts[0] === "identity" || (i.identity && parts.length === 1 && Object.keys(i.identity).some((n) => norm(n) === parts[0]))) {
		const k = parts.length > 1 ? parts.slice(1).join("") : parts[0];
		v = Object.entries(i.identity ?? {}).find(([n]) => norm(n) === k)?.[1];
	} else if (field === "totp") v = i.login?.totp && (await bw(["get", "totp", i.id], env)).trim();
	else if (field === "uri") v = i.login?.uris?.[0]?.uri;
	else if (field === "notes") v = i.notes;
	else if (["username", "password"].includes(field)) v = i.login?.[field] ?? (field === "password" ? i.notes : undefined);
	else v = i.fields?.find((f) => f.name === field)?.value;
	if (!v) throw new Error(`${ref}: item has no ${field}`);
	return v;
}

/** Every item in the vault, with its values (for scan.mjs, which looks for them on the disk). */
export const logins = (env) => all(env);

/** Every passkey in the vault, as stored (login.fido2Credentials). */
export async function passkeys(env) {
	return (await all(env)).flatMap((i) => i.login?.fido2Credentials ?? []);
}

/** Saves a passkey's sign counter back to its item, as Bitwarden's own clients do, so every client keeps counting up from it. */
export async function counted(env, credentialId, count) {
	const item = (await all(env)).find((i) => i.login?.fido2Credentials?.some((p) => p.credentialId === credentialId));
	if (!item) return;
	const fresh = JSON.parse(await bw(["get", "item", item.id], env));
	for (const p of fresh.login.fido2Credentials) if (p.credentialId === credentialId && Number(p.counter) < count) p.counter = String(count);
	await edit(item.id, Buffer.from(JSON.stringify(fresh)).toString("base64"), env);
	items = undefined;
}

/**
 * Moves every item the built-in money list blocks into Raunak's "raubot-blocked" folder, creating it if missing. Only ever moves items in.
 * Returns names and domains, never values. dry: list only.
 */
export async function quarantine(env, dry = true) {
	await unlock(env);
	await bw(["sync"], env);
	const folders = JSON.parse(await bw(["list", "folders"], env));
	const ids = blockedFolderIds(folders);
	const hit = JSON.parse(await bw(["list", "items"], env)).filter((i) => !ids.has(i.folderId) && blockReason(i, ids))
		.map((i) => ({ id: i.id, name: i.name, reason: blockReason(i, ids), uris: (i.login?.uris ?? []).map((u) => u.uri) }));
	if (dry || !hit.length) return hit;
	const folder = folders.find((f) => f.name === FOLDER)?.id ?? JSON.parse(await bw(["create", "folder", Buffer.from(JSON.stringify({ name: FOLDER })).toString("base64")], env)).id;
	for (const h of hit) {
		const fresh = JSON.parse(await bw(["get", "item", h.id], env));
		fresh.folderId = folder;
		await edit(h.id, Buffer.from(JSON.stringify(fresh)).toString("base64"), env);
	}
	items = blocked = undefined;
	return hit;
}

// `bw edit item <id>` reads the encoded item from stdin, keeping it out of argv.
const edit = (id, encoded, env) => new Promise((ok, fail) => {
	const p = execFile(bin(env), ["edit", "item", id], { env: { ...process.env, BITWARDENCLI_APPDATA_DIR: DATA, BW_NOINTERACTION: "true", BW_SESSION: session } }, (e) => (e ? fail(e) : ok()));
	p.stdin.end(encoded);
});

/** Forget the cached items so the next use syncs. */
export const refresh = () => { items = blocked = undefined; };

/** Drops the decrypted items from memory (after a browser run). */
export const forget = () => { items = blocked = undefined; };

export const ready = (env) => fake(env) || NEED.every((k) => env[k]);
