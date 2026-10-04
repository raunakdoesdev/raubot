import { Effect } from "effect";
import type { Frozen } from "./codemode.ts";
import { kv } from "./fx.ts";

// A running script's frozen VM, gzipped in 1 MB chunks (the per-value limit is 2 MB).
const CHUNK = 1 << 20;
const zip = (b: Uint8Array, z: CompressionStream | DecompressionStream) => Effect.promise(() => new Response(new Blob([b]).stream().pipeThrough(z)).bytes());
type Head = Omit<Frozen, "image"> & { n: number };

export const load = (key: string) => Effect.gen(function* () {
	const head = yield* kv.get<Head>(key);
	if (!head) return undefined;
	const parts = yield* Effect.all(Array.from({ length: head.n }, (_, i) => kv.get<Uint8Array>(`${key}:${i}`)));
	const { n: _, ...rest } = head;
	const image = yield* zip(new Uint8Array(yield* Effect.promise(() => new Blob(parts as Uint8Array[]).arrayBuffer())), new DecompressionStream("gzip"));
	return { ...rest, image } satisfies Frozen;
});

export const save = (key: string, f: Frozen) => Effect.gen(function* () {
	const z = yield* zip(f.image, new CompressionStream("gzip"));
	const n = Math.ceil(z.length / CHUNK);
	const { image: _, ...rest } = f;
	const entries: Record<string, unknown> = { [key]: { ...rest, n } satisfies Head };
	for (let i = 0; i < n; i++) entries[`${key}:${i}`] = z.slice(i * CHUNK, (i + 1) * CHUNK);
	yield* kv.put(entries);
});

export const clear = (key: string) => kv.list(key).pipe(Effect.flatMap((m) => (m.size ? kv.delete([...m.keys()]) : Effect.void)));
