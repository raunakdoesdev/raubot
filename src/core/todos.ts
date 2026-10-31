// Tasks, modeled on Claude Duet's Tasks tab: what raubot is working on, what needs Raunak, and what it suggests.
// The iOS app reads them over /api/todos; raubot writes them with tools.todos. Start and brain dump are plain
// user messages into raubot's one conversation, never subagents.

export const STATUSES = ["suggested", "later", "working", "needs_you", "done", "dismissed"] as const;
export type Status = (typeof STATUSES)[number];
export const SOURCES = ["raubot", "user", "brain_dump"] as const;
export type Source = (typeof SOURCES)[number];
/** The app's two lists. Statuses outside both (done, dismissed) are history. */
export const TABS = { active: ["working", "needs_you"], up_next: ["suggested", "later"] } as const satisfies Record<string, readonly Status[]>;
export type Tab = keyof typeof TABS;

export type Todo = {
	id: string; title: string; detail?: string; state: Status; source: Source; source_ref?: string;
	due_at?: string; remind_at?: string; priority?: number; order: number;
	created_at: string; updated_at: string; done_at?: string;
};
export type Device = { token: string; platform: "ios"; env: "sandbox" | "production"; created_at: string };

export type Fields = Partial<Pick<Todo, "title" | "detail" | "state" | "source_ref" | "due_at" | "remind_at" | "priority">>;

export type TodoEvent = { type: "upsert"; version: number; todo: Todo };

export class TodoError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

const str = (v: unknown, name: string, max: number) => {
	if (typeof v !== "string") throw new TodoError(name + ": string");
	return v.trim().slice(0, max);
};
const optStr = (v: unknown, name: string, max: number) => (v === null || v === "" ? undefined : str(v, name, max));
const iso = (v: unknown, name: string) => {
	if (v === null || v === "") return undefined;
	const t = Date.parse(str(v, name, 64));
	if (Number.isNaN(t)) throw new TodoError(name + ": ISO 8601 time");
	return new Date(t).toISOString();
};

/** Parses untrusted fields (HTTP body or tool args); unknown keys are ignored. */
export const parseFields = (raw: unknown): Fields => {
	if (!raw || typeof raw !== "object") throw new TodoError("need a JSON object");
	const o = raw as Record<string, unknown>, f: Fields = {};
	if ("title" in o) { f.title = str(o.title, "title", 300); if (!f.title) throw new TodoError("title: empty"); }
	if ("detail" in o) f.detail = optStr(o.detail, "detail", 8000);
	if ("state" in o) { if (!STATUSES.includes(o.state as Status)) throw new TodoError("state: one of " + STATUSES.join(", ")); f.state = o.state as Status; }
	if ("source_ref" in o) f.source_ref = optStr(o.source_ref, "source_ref", 2000);
	if ("due_at" in o) f.due_at = iso(o.due_at, "due_at");
	if ("remind_at" in o) f.remind_at = iso(o.remind_at, "remind_at");
	if ("priority" in o) {
		if (o.priority !== null && !(Number.isInteger(o.priority) && (o.priority as number) >= 0 && (o.priority as number) <= 3)) throw new TodoError("priority: 0-3");
		f.priority = (o.priority ?? undefined) as number | undefined;
	}
	return f;
};

/** Applies fields and keeps done_at in step with the done state. raubot and the app may set any state. */
export const apply = (t: Todo, f: Fields, now: string): Todo => {
	const next: Todo = { ...t, ...f, updated_at: now };
	for (const k of Object.keys(f) as (keyof Fields)[]) if (f[k] === undefined) delete next[k];
	if (next.state === "done" && t.state !== "done") next.done_at = now;
	if (next.state !== "done") delete next.done_at;
	return next;
};

type Row = Record<string, string | number | null>;
const toTodo = (r: Row): Todo => {
	const t: Todo = {
		id: r.id as string, title: r.title as string, state: r.status as Status, source: r.source as Source, order: r.ord as number,
		created_at: r.created_at as string, updated_at: r.updated_at as string,
	};
	for (const k of ["detail", "source_ref", "due_at", "remind_at", "done_at"] as const) if (r[k] != null) t[k] = r[k] as string;
	if (r.priority != null) t.priority = r.priority as number;
	return t;
};

const OPEN = STATUSES.filter((s) => s !== "done" && s !== "dismissed");

/** The task store in raubot's Durable Object SQLite. Every write bumps one version and emits one event. */
export class Todos {
	#sql: SqlStorage;
	#listeners = new Set<(e: TodoEvent) => void>();
	constructor(sql: SqlStorage) {
		this.#sql = sql;
		sql.exec("CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT, status TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT, due_at TEXT, remind_at TEXT, priority INTEGER, ord REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT)");
		sql.exec("CREATE TABLE IF NOT EXISTS todo_devices (token TEXT PRIMARY KEY, platform TEXT NOT NULL, env TEXT NOT NULL, created_at TEXT NOT NULL)");
		sql.exec("CREATE TABLE IF NOT EXISTS todo_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
	}

	subscribe(f: (e: TodoEvent) => void) { this.#listeners.add(f); return () => void this.#listeners.delete(f); }

	version() { return (this.#sql.exec("SELECT v FROM todo_meta WHERE k = 'version'").toArray()[0]?.v as number | undefined) ?? 0; }
	#bump() { const v = this.version() + 1; this.#sql.exec("INSERT OR REPLACE INTO todo_meta (k, v) VALUES ('version', ?)", v); return v; }
	#emit(e: TodoEvent) { for (const f of this.#listeners) { try { f(e); } catch (err) { console.error("todo listener", err); } } }

	list(statuses?: readonly Status[]): Todo[] {
		const rows = statuses?.length
			? this.#sql.exec("SELECT * FROM todos WHERE status IN (" + statuses.map(() => "?").join(",") + ") ORDER BY ord, created_at", ...statuses).toArray()
			: this.#sql.exec("SELECT * FROM todos ORDER BY ord, created_at").toArray();
		return rows.map((r) => toTodo(r as Row));
	}
	get(id: string) { const r = this.#sql.exec("SELECT * FROM todos WHERE id = ?", id).toArray()[0]; return r ? toTodo(r as Row) : undefined; }

	#put(t: Todo) {
		this.#sql.exec("INSERT OR REPLACE INTO todos (id, title, detail, status, source, source_ref, due_at, remind_at, priority, ord, created_at, updated_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			t.id, t.title, t.detail ?? null, t.state, t.source, t.source_ref ?? null, t.due_at ?? null, t.remind_at ?? null,
			t.priority ?? null, t.order, t.created_at, t.updated_at, t.done_at ?? null);
		this.#emit({ type: "upsert", version: this.#bump(), todo: t });
		return t;
	}

	/** New tasks go to the end. raubot's start as suggested, Raunak's and brain dumps as later (Duet's "saved for later"). */
	add(f: Fields & { title: string }, source: Source): Todo {
		const now = new Date().toISOString();
		const last = (this.#sql.exec("SELECT MAX(ord) AS m FROM todos").toArray()[0]?.m as number | null) ?? 0;
		const base: Todo = { id: crypto.randomUUID().replaceAll("-", "").slice(0, 12), title: f.title, state: source === "raubot" ? "suggested" : "later", source, order: last + 1, created_at: now, updated_at: now };
		return this.#put(apply(base, f, now));
	}

	update(id: string, f: Fields): Todo {
		const t = this.get(id);
		if (!t) throw new TodoError("no task " + id, 404);
		return this.#put(apply(t, f, new Date().toISOString()));
	}

	/** Sets one task's position (any number; the app sends the midpoint of its new neighbours). */
	move(id: string, order: number) {
		this.#sql.exec("UPDATE todos SET ord = ? WHERE id = ?", order, id);
		const t = this.get(id);
		if (!t) throw new TodoError("no task " + id, 404);
		this.#emit({ type: "upsert", version: this.#bump(), todo: t });
		return t;
	}

	addDevice(token: string, env: Device["env"]): Device {
		const d: Device = { token, platform: "ios", env, created_at: new Date().toISOString() };
		this.#sql.exec("INSERT OR REPLACE INTO todo_devices (token, platform, env, created_at) VALUES (?, ?, ?, ?)", d.token, d.platform, d.env, d.created_at);
		return d;
	}
	removeDevice(token: string) { this.#sql.exec("DELETE FROM todo_devices WHERE token = ?", token); }
}


/** System prompt section: Duet's Tasks behavior, with the list kept current as the live brief. */
export const PROMPT = "Tasks: Raunak's iOS app has a Tasks tab (Claude Duet style) next to this chat, backed by tools.todos. Active shows what's being worked on (working) and what needs him (needs_you); Up next shows your suggestions (suggested, with a Start button) and what's saved for later (later). The list is his live brief: reading it at any moment must tell him what's in flight, what's waiting on him and what's next. Keep it current as work happens, in the same turn: a new ask from him becomes a task (working if you start it now, later if not); a job, subagent or Devin run you start sets its task to working; a finished one sets it done (or needs_you when he must review, approve or decide); something he handled himself, or that stopped mattering, goes to done or dismissed; things you notice that he should act on become suggested or needs_you with a source_ref. You can set any state, done included, just as he can. Keep this thread quiet: post here when a task finishes or needs his decision. A \"[todo button clicked on tasks]\" message naming a task id means he tapped Start: it's already working, so do it and set it done when finished. A message starting \"[brain dump]\" is his spoken brain dump: split it into tasks with tools.todos add (source brain_dump, state later unless he asks you to start one now) and reply in one short line.";

/** tools.todos. */
export const TOOL_DOC = "Raunak's task list, shown in his iOS app's Tasks tab (Claude Duet style) and kept current by you as the live brief. States: suggested (you propose; he taps Start or dismisses), later (saved for later), working (being worked on), needs_you (waiting on his decision or approval), done, dismissed. You may set any state. Tabs: active = working + needs_you; up_next = suggested + later.\n" +
	"add: [{ title, detail?, state?, source?, source_ref?, due_at?, remind_at?, priority? }] creates tasks (state defaults to suggested, or later for source \"brain_dump\"; source_ref = Slack permalink, email id, job id, Devin session, etc.; times ISO 8601; priority 0-3). update: [{ id, ...fields }] changes them, e.g. { id, state: \"done\" } when finished. list: { tab?, state?, all? } filters what comes back (default: every task not done or dismissed).\n" +
	"Returns { tasks, version }.";

export type ToolArgs = { add?: unknown[]; update?: unknown[]; list?: { tab?: Tab; state?: Status[]; all?: boolean } };

export const runTool = (store: Todos, { add = [], update = [], list }: ToolArgs) => {
	for (const a of add) {
		const f = parseFields(a);
		if (!f.title) throw new TodoError("add: title required");
		store.add(f as Fields & { title: string }, (a as { source?: unknown }).source === "brain_dump" ? "brain_dump" : "raubot");
	}
	for (const u of update) {
		const id = (u as { id?: unknown } | null)?.id;
		if (typeof id !== "string") throw new TodoError("update: id required");
		store.update(id, parseFields(u));
	}
	const statuses = list?.all ? undefined : list?.state?.length ? list.state : list?.tab ? TABS[list.tab] : OPEN;
	return JSON.stringify({ tasks: store.list(statuses), version: store.version() });
};

const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "cache-control": "no-store" } });
const body = async (req: Request) => { try { return await req.json(); } catch { throw new TodoError("need a JSON body"); } };

/** What the app shows: open tasks and the version. Also the {tasks} event on /ws. */
export const view = (store: Todos) => ({ tasks: store.list(OPEN), version: store.version() });
export type View = ReturnType<typeof view>;

/** The app's task routes: GET /tasks.json, POST /tasks, POST /tasks/<id>, POST /devices, DELETE /devices/<token>. */
export const http = async (store: Todos, req: Request): Promise<Response> => {
	const url = new URL(req.url), p = url.pathname, m = req.method;
	try {
		if (p === "/tasks.json" && m === "GET") return url.searchParams.get("all") ? json({ ...view(store), tasks: store.list() }) : json(view(store));
		if (p === "/tasks" && m === "POST") {
			const f = parseFields(await body(req));
			if (!f.title) throw new TodoError("title required");
			return json(store.add(f as Fields & { title: string }, "user"), 201);
		}
		const one = /^\/tasks\/([\w-]{1,64})$/.exec(p);
		if (one && m === "POST") {
			const raw = (await body(req)) as Record<string, unknown>;
			const { state, order, ...rest } = raw;
			const t = store.update(one[1], parseFields({ ...rest, ...(state !== undefined && { state }) }));
			if (order !== undefined) {
				if (typeof order !== "number" || !Number.isFinite(order)) throw new TodoError("order: number");
				return json(store.move(one[1], order));
			}
			return json(t);
		}
		if (p === "/devices" && m === "POST") {
			const o = (await body(req)) as { apns_token?: unknown; env?: unknown };
			const token = str(o.apns_token, "apns_token", 200);
			if (!/^[0-9a-fA-F]{32,200}$/.test(token)) throw new TodoError("apns_token: hex");
			return json(store.addDevice(token.toLowerCase(), o.env === "production" ? "production" : "sandbox"), 201);
		}
		const dev = /^\/devices\/([0-9a-fA-F]{32,200})$/.exec(p);
		if (dev && m === "DELETE") { store.removeDevice(dev[1].toLowerCase()); return json({ removed: true }); }
		return json({ error: "not found" }, 404);
	} catch (e) {
		if (e instanceof TodoError) return json({ error: e.message }, e.status);
		throw e;
	}
};

/** POST /todo with an id (the Tasks tab's Start): the task goes to working and the message names it. */
export const start = (store: Todos, id: string) => store.update(id, { state: "working" });
