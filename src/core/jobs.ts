import { Context, Data, Effect, Layer } from "effect";
import type { Origin } from "./channels/index.ts";
import { kv, Storage } from "./fx.ts";

export type Status = "running" | "done" | "failed" | "timed out" | "cancelled";
export type Job = { id: number; label: string; code: string; from: Origin; status: Status; started: number; deadline: number; ended?: number };

export const MAX_RUNNING = 100;
export const MAX_TIMEOUT = 86_400;

export class JobError extends Data.TaggedError("JobError")<{ message: string }> {}

/** What jobs need from raubot: run a script, bump raubot with a result, stop a job's subagents. */
export class JobHost extends Context.Tag("JobHost")<JobHost, {
	run(job: Job, signal: AbortSignal): Promise<{ text: string; error?: boolean }>;
	bump(from: Origin, text: string): Promise<void>;
	stopChildren(id: number): Promise<void>;
}>() {}

/** Background jobs: codemode scripts run outside any turn. Each reports back once, as a `[job <id> <status>]` message on the channel it started from. */
export class Jobs extends Context.Tag("Jobs")<Jobs, {
	start(code: string, label: string, timeout: number, from: Origin): Effect.Effect<Job, JobError>;
	list(): Effect.Effect<Job[]>;
	cancel(id: number): Effect.Effect<void>;
	/** Forget finished jobs. */
	prune(): Effect.Effect<void>;
	/** Restart jobs a DO restart interrupted; how many run. */
	resume(): Effect.Effect<number>;
}>() {}

export const JobsLive = Layer.effect(Jobs, Effect.gen(function* () {
	const storage = yield* Storage;
	const host = yield* JobHost;
	const running = new Map<number, AbortController>();
	const at = (id: number) => `job:${id}`;
	const all = kv.list<Job>("job:").pipe(Effect.map((m) => [...m.values()].sort((a, b) => a.id - b.id)), Effect.provideService(Storage, storage));
	const get = (id: number) => kv.get<Job>(at(id)).pipe(Effect.provideService(Storage, storage));
	const put = (j: Job) => kv.put({ [at(j.id)]: j }).pipe(Effect.provideService(Storage, storage));

	const run = (job: Job) => Effect.gen(function* () {
		if (running.has(job.id)) return;
		const ac = new AbortController();
		running.set(job.id, ac);
		const r = yield* Effect.tryPromise(() => host.run(job, ac.signal)).pipe(
			Effect.catchAll((e) => Effect.succeed({ text: String(e), error: true })),
			Effect.ensuring(Effect.sync(() => running.delete(job.id))),
		);
		const now = yield* get(job.id);
		if (now?.status !== "running") return; // cancelled or reset
		const status: Status = !r.error ? "done" : Date.now() > job.deadline ? "timed out" : "failed";
		yield* put({ ...now, status, ended: Date.now() });
		yield* Effect.promise(() => host.bump(job.from, `[job ${job.id} ${status}] ${job.label}\n${r.text}`));
	}).pipe(Effect.catchAllCause(Effect.logError), Effect.forkDaemon, Effect.asVoid);

	return {
		start: (code, label, timeout, from) => Effect.gen(function* () {
			if (!(timeout > 0 && timeout <= MAX_TIMEOUT)) return yield* new JobError({ message: `timeout must be 1..${MAX_TIMEOUT} seconds.` });
			if ((yield* all).filter((j) => j.status === "running").length >= MAX_RUNNING) return yield* new JobError({ message: `${MAX_RUNNING} jobs are already running: cancel some first.` });
			const id = ((yield* kv.get<number>("job-next").pipe(Effect.provideService(Storage, storage))) ?? 1);
			const now = Date.now();
			const job: Job = { id, label, code, from, status: "running", started: now, deadline: now + timeout * 1000 };
			yield* kv.put({ "job-next": id + 1, [at(id)]: job }).pipe(Effect.provideService(Storage, storage));
			yield* run(job);
			return job;
		}),
		list: () => all,
		cancel: (id) => Effect.gen(function* () {
			const job = yield* get(id);
			if (job?.status !== "running") return;
			yield* put({ ...job, status: "cancelled", ended: Date.now() });
			running.get(id)?.abort();
			yield* Effect.promise(() => host.stopChildren(id));
		}),
		prune: () => all.pipe(Effect.flatMap((js) => kv.delete(js.filter((j) => j.status !== "running").map((j) => at(j.id)))), Effect.provideService(Storage, storage)),
		resume: () => all.pipe(
			Effect.map((js) => js.filter((j) => j.status === "running")),
			Effect.tap((js) => Effect.forEach(js, run)),
			Effect.map((js) => js.length),
		),
	};
}));
