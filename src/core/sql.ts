import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

type Bind = null | number | string | ArrayBuffer;
const bind = (params: SqliteValue[]): Bind[] =>
	params.map((p) =>
		typeof p === "bigint" ? Number(p) : p instanceof Uint8Array ? (p.slice().buffer as ArrayBuffer) : p,
	);
const row = <T>(r: Record<string, unknown>): T => {
	for (const k in r) if (r[k] instanceof ArrayBuffer) r[k] = new Uint8Array(r[k] as ArrayBuffer);
	return r as T;
};

/** pi-durable's async SqliteDatabase over a Durable Object's synchronous SQL API. */
export class DoSqlite implements SqliteDatabase {
	#tail: Promise<unknown> = Promise.resolve();
	storage: DurableObjectStorage;
	constructor(storage: DurableObjectStorage) { this.storage = storage; }

	#exec(sql: string, params: SqliteValue[]): Record<string, unknown>[] {
		return this.storage.sql.exec(sql, ...bind(params)).toArray() as Record<string, unknown>[];
	}
	#direct: SqliteExecutor = {
		exec: async (sql) => void this.storage.sql.exec(sql),
		run: async (sql, ...p) => void this.#exec(sql, p),
		get: async <T extends object>(sql: string, ...p: SqliteValue[]) => {
			const rows = this.#exec(sql, p);
			return rows.length === 0 ? undefined : row<T>(rows[0]);
		},
		all: async <T extends object>(sql: string, ...p: SqliteValue[]) => this.#exec(sql, p).map((r) => row<T>(r)),
	};
	#queue<T>(op: () => Promise<T>): Promise<T> {
		const next = this.#tail.then(op, op);
		this.#tail = next.catch(() => {});
		return next;
	}

	exec(sql: string) { return this.#queue(() => this.#direct.exec(sql)); }
	run(sql: string, ...p: SqliteValue[]) { return this.#queue(() => this.#direct.run(sql, ...p)); }
	get<T extends object>(sql: string, ...p: SqliteValue[]) { return this.#queue(() => this.#direct.get<T>(sql, ...p)); }
	all<T extends object>(sql: string, ...p: SqliteValue[]) { return this.#queue(() => this.#direct.all<T>(sql, ...p)); }
	transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#queue(() => this.storage.transaction(() => callback(this.#direct)));
	}
	async close() {}
}
