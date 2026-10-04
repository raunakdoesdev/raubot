// Shared Effect services. pi-durable, chord and QuickJS are promise-based, so effects run at those edges via `runner`.
import { Cause, Context, Data, Effect, Exit, Layer, type ManagedRuntime } from "effect";
import type { Computer } from "./box.ts";

/** Durable Object storage. Its failures are defects: the DO can't go on without it. */
export class Storage extends Context.Tag("Storage")<Storage, DurableObjectStorage>() {}

const use = <A>(f: (s: DurableObjectStorage) => Promise<A>) => Effect.flatMap(Storage, (s) => Effect.promise(() => f(s)));
export const kv = {
	get: <T>(key: string) => use((s) => s.get<T>(key)),
	put: (entries: Record<string, unknown>) => use((s) => s.put(entries)),
	delete: (keys: string[]) => use((s) => s.delete(keys)),
	list: <T>(prefix: string) => use((s) => s.list<T>({ prefix })),
};

export class BoxError extends Data.TaggedError("BoxError")<{ message: string }> {}

/** The Linux box. */
export class Box extends Context.Tag("Box")<Box, {
	bash(cmd: string, timeout: number): Effect.Effect<string, BoxError>;
	write(path: string, bytes: Uint8Array): Effect.Effect<void, BoxError>;
}>() {}

export const BoxLive = (ns: DurableObjectNamespace<Computer>) => Layer.succeed(Box, {
	bash: (cmd, timeout) => Effect.tryPromise({
		try: () => ns.getByName("main").bash(cmd, timeout) as Promise<string>,
		catch: (e) => new BoxError({ message: String(e) }),
	}),
	write: (path, bytes) => Effect.tryPromise({
		try: () => ns.getByName("main").write(path, bytes),
		catch: (e) => new BoxError({ message: String(e) }),
	}),
});

export const bash = (cmd: string, timeout: number) => Effect.flatMap(Box, (b) => b.bash(cmd, timeout));
export const write = (path: string, bytes: Uint8Array) => Effect.flatMap(Box, (b) => b.write(path, bytes));

/** Runs an effect at a promise edge; a typed failure is rethrown as itself so callers see its message. */
export const runner = <R>(rt: ManagedRuntime.ManagedRuntime<R, never>) => async <A, E>(e: Effect.Effect<A, E, R>): Promise<A> => {
	const exit = await rt.runPromiseExit(e);
	if (Exit.isSuccess(exit)) return exit.value;
	throw Cause.squash(exit.cause);
};
