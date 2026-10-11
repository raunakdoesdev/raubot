// A stand-in for the bw CLI for leaktest.mts (no values in it): unlock checks the master password, writes a cache to its data dir like bw does, serves items from env.
const fs = require("fs"), crypto = require("crypto"), [cmd, sub] = process.argv.slice(2), e = process.env, dir = e.BITWARDENCLI_APPDATA_DIR;
if (cmd === "status") console.log(JSON.stringify({ status: "unauthenticated" }));
else if (cmd === "login") { if (!e.BW_CLIENTID || !e.BW_CLIENTSECRET) process.exit(1); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + "/data.json", JSON.stringify({ clientId: e.BW_CLIENTID, clientSecret: e.BW_CLIENTSECRET })); }
else if (cmd === "unlock") { if (e.BW_PASSWORD !== e.BW_FAKE_PASSWORD) process.exit(1); fs.appendFileSync(dir + "/data.json", JSON.stringify({ session: e.BW_FAKE_SESSION })); process.stdout.write(e.BW_FAKE_SESSION); }
else if (cmd === "sync") {}
else if (cmd === "list" && sub === "items") { if (e.BW_SESSION !== e.BW_FAKE_SESSION) process.exit(1); fs.appendFileSync(dir + "/data.json", e.BW_FAKE_ITEMS); console.log(e.BW_FAKE_ITEMS); }
else if (cmd === "get" && sub === "item") { if (e.BW_SESSION !== e.BW_FAKE_SESSION) process.exit(1); console.log(JSON.stringify(JSON.parse(e.BW_FAKE_ITEMS)[0])); }
else if (cmd === "get" && sub === "totp") { if (e.BW_SESSION !== e.BW_FAKE_SESSION) process.exit(1); const i = JSON.parse(e.BW_FAKE_ITEMS).find((x) => x.id === process.argv[4]); if (!i?.login?.totp) process.exit(1); console.log(totp(i.login.totp)); }
else if (cmd === "edit" && sub === "item") { let b = ""; process.stdin.on("data", (d) => (b += d)).on("end", () => fs.appendFileSync(dir + "/data.json", Buffer.from(b, "base64").toString())); }
else process.exit(2);
function totp(seed, t = Date.now()) {
	const b = [...seed.toUpperCase().replace(/[^A-Z2-7]/g, "")].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
	const key = Buffer.from(b.match(/.{8}/g).map((x) => parseInt(x, 2))), msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
	const h = crypto.createHmac("sha1", key).update(msg).digest(), o = h[19] & 15;
	return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}
