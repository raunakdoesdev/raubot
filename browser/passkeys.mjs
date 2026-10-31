// Bitwarden passkeys (login.fido2Credentials) as credentials on Chromium's virtual WebAuthn authenticator.
// Bitwarden stores the credential id as a GUID (its 16 raw bytes) or "b64.<base64url>", and keyValue (PKCS#8) and userHandle as base64url.
const b64 = (s) => Buffer.from(s, "base64url").toString("base64");

export const rawId = (id) => (id.startsWith("b64.") ? Buffer.from(id.slice(4), "base64url") : Buffer.from(id.replace(/-/g, ""), "hex"));

export const credential = (p, discoverable = p.discoverable !== "false") => ({
	credentialId: rawId(p.credentialId).toString("base64"),
	isResidentCredential: discoverable,
	rpId: p.rpId,
	privateKey: b64(p.keyValue),
	...(p.userHandle ? { userHandle: b64(p.userHandle) } : {}),
	signCount: Number(p.counter) || 0,
	backupEligibility: true,
	backupState: true,
	...(p.userName ? { userName: p.userName } : {}),
	...(p.userDisplayName ? { userDisplayName: p.userDisplayName } : {}),
});

/**
 * The authenticator's credentials. When a site has several passkeys (Google: raunak@, admin-raunak@, a gmail account), none is discoverable:
 * otherwise the site's passkey autofill signs in with whichever comes first before an email is typed. The site then asks for the passkey of the typed account.
 */
export const credentials = (passkeys) => {
	const n = new Map();
	for (const p of passkeys) n.set(p.rpId, (n.get(p.rpId) ?? 0) + 1);
	return passkeys.map((p) => [p, credential(p, n.get(p.rpId) === 1 && p.discoverable !== "false")]);
};

/**
 * A platform authenticator on `page` that verifies the user without prompting. `set` replaces its passkeys.
 * Chromium bumps the sign counter on every use; `onUse(passkey, count)` reports it so the vault can keep it.
 */
export async function attach(page, onUse = () => {}) {
	const s = await page.context().newCDPSession(page);
	await s.send("WebAuthn.enable", { enableUI: false });
	const { authenticatorId } = await s.send("WebAuthn.addVirtualAuthenticator", {
		options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
	});
	let byId = new Map();
	s.on("WebAuthn.credentialAsserted", (e) => { const p = byId.get(e.credential.credentialId); if (p) onUse(p, e.credential.signCount); });
	return {
		session: s, authenticatorId,
		async set(passkeys) {
			await s.send("WebAuthn.clearCredentials", { authenticatorId });
			byId = new Map();
			for (const [p, c] of credentials(passkeys)) {
				byId.set(c.credentialId, p);
				await s.send("WebAuthn.addCredential", { authenticatorId, credential: c }).catch((e) => console.error(`passkey ${p.rpId}: ${e.message}`));
			}
		},
	};
}
