// The local site leaktest.mts signs in to: a password form, and a passkey (rpId localhost, non-discoverable) checked against SITE_PK_PUB.
// Sessions are HMACs of SITE_KEY, so they still validate after the box restarts. Nothing here is cached by the browser (no-store).
const http = require("http"), crypto = require("crypto"), e = process.env, challenges = new Set();
const sid = crypto.createHmac("sha256", e.SITE_KEY).update(e.SITE_USER).digest("hex");
const pkSid = crypto.createHmac("sha256", e.SITE_KEY).update("pk").digest("hex");
const body = (req) => new Promise((ok) => { let b = ""; req.on("data", (d) => (b += d)).on("end", () => ok(b)); });
const pkPage = `<title>pk</title><script>
const d = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");
(async () => {
	const { c, id } = await (await fetch("/pk/challenge")).json();
	const r = await navigator.credentials.get({ publicKey: { challenge: d(c), rpId: "localhost", allowCredentials: [{ type: "public-key", id: d(id) }], userVerification: "preferred" } });
	const ok = await fetch("/pk/verify", { method: "POST", body: JSON.stringify({ clientDataJSON: u(r.response.clientDataJSON), authenticatorData: u(r.response.authenticatorData), signature: u(r.response.signature) }) });
	document.title = ok.ok ? "pk verified" : "pk refused";
	if (ok.ok) location = "/pkhome";
})().catch((x) => (document.title = "pk error " + x.name));
</script>`;
http.createServer(async (req, res) => {
	const cookie = req.headers.cookie || "";
	const page = (html) => res.writeHead(200, { "cache-control": "no-store", "content-type": "text/html" }).end(html);
	if (req.method === "POST" && req.url === "/login") {
		const f = new URLSearchParams(await body(req));
		if (f.get("u") === e.SITE_USER && f.get("p") === e.SITE_PASS) return res.writeHead(302, { "set-cookie": `sid=${sid}; Max-Age=86400; Path=/; HttpOnly`, location: "/home" }).end();
		return res.writeHead(401).end("bad login");
	}
	if (req.url === "/pk/challenge") {
		const c = crypto.randomBytes(32).toString("base64url");
		challenges.add(c);
		return res.writeHead(200, { "cache-control": "no-store", "content-type": "application/json" }).end(JSON.stringify({ c, id: e.SITE_PK_ID }));
	}
	if (req.method === "POST" && req.url === "/pk/verify") {
		try {
			const a = JSON.parse(await body(req)), cd = Buffer.from(a.clientDataJSON, "base64url");
			const signed = Buffer.concat([Buffer.from(a.authenticatorData, "base64url"), crypto.createHash("sha256").update(cd).digest()]);
			if (!challenges.delete(JSON.parse(cd).challenge) || !crypto.verify("sha256", signed, { key: e.SITE_PK_PUB, dsaEncoding: "der" }, Buffer.from(a.signature, "base64url"))) throw 0;
			return res.writeHead(200, { "set-cookie": `pk=${pkSid}; Max-Age=86400; Path=/; HttpOnly`, "cache-control": "no-store" }).end("ok");
		} catch { return res.writeHead(401).end("bad"); }
	}
	if (req.url === "/pk") return page(pkPage);
	if (req.url === "/pkhome") return page(cookie.includes(`pk=${pkSid}`) ? "<title>pk home</title><p id=pkok>passkey ok</p>" : "<title>pk login</title>");
	if (req.url === "/home" && cookie.includes(`sid=${sid}`)) return page("<title>home</title><p id=w>welcome</p><script>localStorage.setItem('seen', '1')</script>");
	page('<title>login</title><form method=post action=/login><input id=u name=u autocomplete=username><input id=p name=p type=password autocomplete=current-password><button>Sign in</button></form>');
}).listen(8099);
