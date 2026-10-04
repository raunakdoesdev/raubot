// Secrets the user pastes in for raubot. Values are AES-GCM encrypted at rest with a key that lives only in the Worker's env (SECRETS_KEY),
// and reach nothing but the box's env for one command; the model sees names, never values.
import { Context, Data, Effect, Layer } from "effect";
import type { Origin } from "./channels/index.ts";
import { kv, Storage } from "./fx.ts";

/** What raubot and the UI see about a secret. */
export type Secret = { name: string; why: string; set: number; expires?: number };
/** A pending ask: the token is the only key to its form, so it's long, single-use and short-lived. */
export type Ask = { token: string; name: string; why: string; from: Origin; until: number };
type Sealed = Secret & { iv: string; data: string };

export class SecretError extends Data.TaggedError("SecretError")<{ message: string; status: number }> {}

export class Secrets extends Context.Tag("Secrets")<Secrets, {
	ask(name: string, why: string, from: Origin): Effect.Effect<Ask, SecretError>;
	asks(): Effect.Effect<Ask[]>;
	find(token: string): Effect.Effect<Ask, SecretError>;
	/** Answers an ask; `ttl` in seconds, none means kept until removed. */
	answer(token: string, value: string, ttl?: number): Effect.Effect<Ask, SecretError>;
	list(): Effect.Effect<Secret[]>;
	remove(names: string[]): Effect.Effect<void>;
	/** Every live secret by name, for the box's env. */
	env(): Effect.Effect<Record<string, string>>;
}>() {}

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ASK_TTL = 7 * 86_400_000;
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fail = (message: string, status = 400) => Effect.fail(new SecretError({ message, status }));

/** Scrubs secret values out of text the model will read. */
export const redact = (env: Record<string, string>, s: string) =>
	Object.entries(env).filter(([, v]) => v.length >= 4).sort((a, b) => b[1].length - a[1].length)
		.reduce((out, [k, v]) => out.split(v).join(`[secret ${k}]`), s);

export const SecretsLive = (rawKey: string) => Layer.effect(Secrets, Effect.gen(function* () {
	const store = yield* Storage;
	const run = <A, E>(e: Effect.Effect<A, E, Storage>) => Effect.provideService(e, Storage, store);
	const key = yield* Effect.promise(() => crypto.subtle.importKey("raw", unb64(rawKey ?? ""), "AES-GCM", false, ["encrypt", "decrypt"])).pipe(Effect.orDie);
	const ad = (name: string) => new TextEncoder().encode(name);
	const live = run(kv.list<Sealed>("secret:")).pipe(Effect.flatMap((all) => {
		const dead = [...all].filter(([, s]) => s.expires && s.expires < Date.now()).map(([k]) => k);
		return Effect.as(dead.length ? run(kv.delete(dead)) : Effect.void, [...all.values()].filter((s) => !s.expires || s.expires >= Date.now()));
	}));
	const asks = run(kv.list<Ask>("ask:")).pipe(Effect.map((m) => [...m.values()].filter((a) => a.until > Date.now())));
	const find = (token: string) => run(kv.get<Ask>(`ask:${token}`)).pipe(Effect.flatMap((a) => (a && a.until > Date.now() ? Effect.succeed(a) : fail("This link has expired or was already used.", 404))));
	return {
		ask: (name, why, from) => Effect.gen(function* () {
			if (!NAME.test(name)) return yield* fail(`Secret names look like GITHUB_TOKEN: ${JSON.stringify(name)} isn't one.`);
			const open = (yield* asks).find((a) => a.name === name);
			if (open) return open;
			const a: Ask = { token: b64(crypto.getRandomValues(new Uint8Array(24))).replace(/\+/g, "-").replace(/\//g, "_"), name, why, from, until: Date.now() + ASK_TTL };
			yield* run(kv.put({ [`ask:${a.token}`]: a }));
			return a;
		}),
		asks: () => asks,
		find,
		answer: (token, value, ttl) => Effect.gen(function* () {
			const a = yield* find(token);
			if (!value) return yield* fail("Paste a value.");
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const data = yield* Effect.promise(() => crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad(a.name) }, key, new TextEncoder().encode(value)));
			const s: Sealed = { name: a.name, why: a.why, set: Date.now(), expires: ttl ? Date.now() + ttl * 1000 : undefined, iv: b64(iv), data: b64(data) };
			yield* run(kv.put({ [`secret:${a.name}`]: s }));
			yield* run(kv.delete([`ask:${token}`]));
			return a;
		}),
		list: () => Effect.map(live, (all) => all.map(({ iv: _, data: __, ...s }) => s)),
		remove: (names) => Effect.asVoid(run(kv.delete(names.map((n) => `secret:${n}`)))),
		env: () => Effect.flatMap(live, (all) => Effect.forEach(all, (s) => Effect.tryPromise(() =>
			crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv), additionalData: ad(s.name) }, key, unb64(s.data))).pipe(
			Effect.map((v) => [[s.name, new TextDecoder().decode(v)] as const]),
			Effect.tapError(() => Effect.logWarning(`secret ${s.name} doesn't decrypt (SECRETS_KEY changed?)`)),
			Effect.orElseSucceed(() => []),
		))).pipe(Effect.map((e) => Object.fromEntries(e.flat()))),
	};
}));
