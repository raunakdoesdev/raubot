// Sends one message to staging raubot over /ws and prints its log lines until it goes idle with a reply. Run with CF Access creds in env:
// vault run --env CF_ID=bw://c4a2aaeb-3f65-4339-806a-b4eb008825ef/username --env CF_SECRET=bw://c4a2aaeb-3f65-4339-806a-b4eb008825ef/password -- node raubot/test/staging-say.mjs "text"
const text = process.argv[2];
const limit = Number(process.argv[3] ?? 600) * 1000;
const ws = new WebSocket("wss://raubot-staging.example.com/ws", { headers: { "CF-Access-Client-Id": process.env.CF_ID, "CF-Access-Client-Secret": process.env.CF_SECRET } });
let busy = true, sent = false, seen = 0, talk = false, t0 = Date.now();
const done = (code) => { ws.close(); process.exit(code); };
setTimeout(() => { console.log("TIMEOUT"); done(2); }, limit);
ws.onmessage = (ev) => {
	const m = JSON.parse(String(ev.data));
	if (process.env.DEBUG) console.log("msg", Object.keys(m).join(","), m.busy);
	if (m.history && !sent) { seen = m.history.length ? m.history.at(-1).i : -1; sent = true; ws.send(JSON.stringify({ send: text })); return; }
	for (const l of m.history ?? []) {
		if (l.i <= seen) continue;
		seen = l.i;
		console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${l.kind}: ${String(l.text).slice(0, 700)}`);
		if (l.kind === "talk") talk = true;
	}
	if (m.busy !== undefined) busy = m.busy;
	if (m.error) console.log("ERROR", m.error);
	if (talk && !busy) setTimeout(() => !busy && done(0), 3000);
	if (m.status) console.log("status", m.status);
};
ws.onerror = (e) => { console.log("WS ERROR", e.message ?? e); done(1); };
