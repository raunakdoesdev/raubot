// Devin runs raubot started: a durable registry, signed completion callbacks, and an hourly safety net (instead of gather-polling).
import { Data, Effect } from "effect";
import type { Origin } from "./channels/index.ts";
import { kv } from "./fx.ts";

/** One run raubot started. key is raubot's own id (known before Devin gives a session id); session is the Devin id once linked. */
export type Run = {
	key: string; session?: string; purpose: string; started: number; status: "open" | "closed";
	/** Last Devin status seen ("running/working", "exit/...") or the last callback ("callback:done"). */
	last?: string; checked?: number; notified?: string; flagged?: boolean; summary?: string;
	secret: string; from: Origin; seen?: Record<string, number>;
};

export class DevinError extends Data.TaggedError("DevinError")<{ message: string; status: number }> {}

const KEY = /^[\w-]{6,64}$/;
/** Callbacks older or newer than this are refused (seconds). */
export const SKEW = 300;
export const HOUR = 3_600_000;
/** An open run still working after this long gets flagged once as stuck. */
export const STALE = 24 * HOUR;

const at = (key: string) => "devin:" + key;
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const fail = (message: string, status = 400) => Effect.fail(new DevinError({ message, status }));
const bare = (id: string) => id.replace(/^devin-/, "");

export const all = kv.list<Run>("devin:").pipe(Effect.map((m) => [...m.values()].sort((a, b) => a.started - b.started)));
export const open = Effect.map(all, (rs) => rs.filter((r) => r.status === "open"));
export const get = (key: string) => kv.get<Run>(at(key));
export const update = (r: Run) => kv.put({ [at(r.key)]: r });

/** A run by raubot key or Devin session id (with or without the devin- prefix). */
export const find = (id: string) => Effect.map(all, (rs) => rs.find((r) => r.key === id || (!!r.session && bare(r.session) === bare(id))));

/** What raubot reads about a run: no secret, no replay log. */
export const show = ({ secret: _, seen: __, from: ___, ...r }: Run) => ({ ...r, started: new Date(r.started).toISOString(), checked: r.checked ? new Date(r.checked).toISOString() : undefined });

export const sign = async (secret: string, msg: string) => {
	const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
};

/** Constant-time compare of two equal-format hex strings. */
const same = (a: string, b: string) => {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
};

/** Ready-to-paste lines for a Devin prompt. Body: plain-text summary. Signature: hex HMAC-SHA256(secret, "<ts>.<status>.<body>"). */
export const curl = (url: string, r: Run) => {
	const endpoint = url + "/s/devin/" + r.key;
	const fn = "devin_done() { S=\"$1\"; B=\"$2\"; T=$(date +%s); G=$(printf '%s' \"$T.$S.$B\" | openssl dgst -sha256 -hmac '" + r.secret + "' -r | cut -d' ' -f1); "
		+ "curl -sS -X POST '" + endpoint + "?status='\"$S\" -H \"x-raubot-ts: $T\" -H \"x-raubot-sig: $G\" -H 'content-type: text/plain' --data-binary \"$B\"; }";
	return {
		endpoint,
		curl: fn,
		prompt: "When you finish or get blocked, run this in a shell. Status is done, blocked or failed; then a 1-3 sentence summary with PR links:\n" + fn + "\ndevin_done done \"<summary>\"",
	};
};

export const add = (purpose: string, from: Origin, key?: string, session?: string) => Effect.gen(function* () {
	const k = key ?? "r" + Date.now().toString(36) + hex(crypto.getRandomValues(new Uint8Array(3)));
	if (!KEY.test(k)) return yield* fail("key: 6-64 letters, digits, - or _");
	if (yield* get(k)) return yield* fail("run " + k + " already exists");
	const r: Run = { key: k, session: session && "devin-" + bare(session), purpose, started: Date.now(), status: "open", secret: hex(crypto.getRandomValues(new Uint8Array(32))), from };
	yield* update(r);
	return r;
});

export const link = (key: string, session: string) => Effect.gen(function* () {
	const r = yield* get(key);
	if (!r) return yield* fail("no run " + key, 404);
	const next: Run = { ...r, session: "devin-" + bare(session) };
	yield* update(next);
	return next;
});

export const close = (ids: string[]) => Effect.forEach(ids, (id) => Effect.gen(function* () {
	const r = yield* find(id);
	if (r && r.status === "open") yield* update({ ...r, status: "closed" });
	return r?.key;
}));

export const message = (r: Run, status: string, summary?: string) =>
	"[devin " + (r.session ?? r.key) + " " + status + "] " + r.purpose + (summary ? "\n" + summary : "") + (r.session ? "\nhttps://app.devin.ai/sessions/" + bare(r.session) : "");

/** Checks a callback; gives the updated run and the message to deliver, or fails with an HTTP status. */
export const callback = (key: string, status: string, ts: string, sig: string, body: string, now = Date.now()) => Effect.gen(function* () {
	const r = KEY.test(key) ? yield* get(key) : undefined;
	if (!r) return yield* fail("unknown run", 404);
	if (!/^(done|blocked|failed)$/.test(status)) return yield* fail("status: done, blocked or failed");
	const t = Number(ts);
	if (!ts || !Number.isInteger(t) || Math.abs(now / 1000 - t) > SKEW) return yield* fail("stale or missing timestamp", 401);
	const want = yield* Effect.promise(() => sign(r.secret, ts + "." + status + "." + body));
	if (!/^[0-9a-f]{64}$/.test(sig) || !same(sig, want)) return yield* fail("bad signature", 401);
	const seen = Object.fromEntries(Object.entries(r.seen ?? {}).filter(([, v]) => v > now - 2 * SKEW * 1000));
	if (seen[sig]) return yield* fail("replayed", 409);
	seen[sig] = now;
	const summary = body.trim().slice(0, 2000);
	const next: Run = { ...r, seen, summary, last: "callback:" + status, notified: "callback:" + status, status: status === "blocked" ? "open" : "closed" };
	yield* update(next);
	return { run: next, text: message(next, status, summary) };
});

/** Parses devin_session_interact get text into session id -> fields. */
export const parse = (text: string) => {
	const out: Record<string, Record<string, string>> = {};
	let cur: Record<string, string> | undefined;
	for (const line of text.split("\n")) {
		const s = /^Session (\S+?):\s*$/.exec(line);
		if (s) { out[bare(s[1])] = cur = {}; continue; }
		const f = /^\s+(\w+):\s?(.*)$/.exec(line);
		if (f && cur) cur[f[1]] = f[2];
	}
	return out;
};

/** What the safety net does about a run, from Devin's status and status_detail. */
export const judge = (r: Run, status: string, detail: string, now = Date.now()): { close: boolean; notify?: string; flag?: boolean } => {
	const state = status + "/" + detail;
	if (/^(exit|error|suspended)$/.test(status) || detail === "finished")
		return { close: true, notify: r.notified === "callback:done" || r.notified === "callback:failed" ? undefined : status === "error" ? "failed" : "done" };
	if (/^waiting_for_(user|approval)$/.test(detail)) return { close: false, notify: r.notified === state || r.notified === "callback:blocked" ? undefined : "blocked" };
	return { close: false, flag: !r.flagged && now - r.started > STALE };
};

/** Applies one Devin get result to the open runs: gives updated runs and the messages to deliver. */
export const review = (runs: Run[], text: string, now = Date.now()) => {
	const got = parse(text), out: { run: Run; text?: string }[] = [];
	for (const r of runs) {
		const s = r.session && r.status === "open" ? got[bare(r.session)] : undefined;
		if (!s) continue;
		const status = s.status ?? "", detail = s.status_detail ?? "";
		const j = judge(r, status, detail, now);
		const summary = s.summary && !/not generated/.test(s.summary) ? s.summary : r.summary;
		const next: Run = { ...r, last: status + "/" + detail, checked: now, summary, status: j.close ? "closed" : "open",
			...(j.notify && { notified: status + "/" + detail }), ...(j.flag && { flagged: true }) };
		const note = j.notify ? message(next, j.notify + ", no callback", summary)
			: j.flag ? message(next, "stuck", "Still " + status + "/" + detail + " after " + Math.round((now - r.started) / HOUR) + "h.") : undefined;
		out.push({ run: next, text: note });
	}
	return out;
};

/** The hourly safety net as a quiet job's script: finds the Devin tool, reads every open run, reports back through tools.devin_runs. */
export const CHECK = [
	"const runs = JSON.parse(await tools.devin_runs({}));",
	"const ids = runs.filter((r) => r.session).map((r) => r.session);",
	"if (!ids.length) return 'devin-check: nothing open';",
	"const s = await tools.search({ query: 'devin_session_interact' });",
	"const t = typeof s === 'string' ? s : JSON.stringify(s);",
	"const i = t.indexOf('].devin_session_interact'), j = t.lastIndexOf('ins_', i);",
	"if (i < 0 || j < 0) throw new Error('devin-check: no Devin tool');",
	"const out = await tools.devin[\"profiles\"][t.slice(j, j + 40)].devin_session_interact({ action: 'get', session_id: ids.slice(0, 100), summary: true });",
	"return await tools.devin_runs({ report: String(out) });",
].join("\n");
