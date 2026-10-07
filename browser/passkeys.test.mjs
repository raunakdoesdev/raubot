// node browser/passkeys.test.mjs
import assert from "node:assert/strict";
import { credentials } from "./passkeys.mjs";

const key = (rpId, userName, extra = {}) => ({ rpId, userName, credentialId: crypto.randomUUID(), keyValue: "AAAA", counter: "0", ...extra });
const out = credentials([
	key("google.com", "raunak@reducto.ai"),
	key("google.com", "admin-raunak@reducto.ai"),
	key("vercel.com", "raunak"),
	key("github.com", "raunak", { discoverable: "false" }),
]);
const resident = Object.fromEntries(out.map(([p, c]) => [`${p.rpId} ${p.userName}`, c.isResidentCredential]));
assert.deepEqual(resident, {
	"google.com raunak@reducto.ai": false,
	"google.com admin-raunak@reducto.ai": false,
	"vercel.com raunak": true,
	"github.com raunak": false,
});
console.log("passkeys ok");
