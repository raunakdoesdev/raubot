// Raunak's vault blocklist: items raubot is never granted. Source of truth is his Bitwarden folder "raubot-blocked";
// the built-in money list below blocks banks, brokerages and money movement wherever they are filed.
import { getDomain } from "tldts";

export const FOLDER = "raubot-blocked";

export const DOMAINS = new Set([
	"mercury.com", "chase.com", "bankofamerica.com", "bofa.com", "wellsfargo.com", "schwab.com", "fidelity.com", "vanguard.com",
	"robinhood.com", "coinbase.com", "americanexpress.com", "amex.com", "capitalone.com", "citi.com", "citibank.com", "svb.com",
	"firstcitizens.com", "brex.com", "wise.com", "transferwise.com", "venmo.com", "zellepay.com", "paypal.com", "cash.app", "cashapp.com",
	"square.com", "ally.com", "discover.com", "marcus.com", "wealthfront.com", "betterment.com", "etrade.com", "interactivebrokers.com",
	"ibkr.com", "morganstanley.com",
]);

const NAMES = /\b(mercury|chase|bank of america|bofa|wells fargo|schwab|fidelity|vanguard|robinhood|coinbase|amex|american express|capital ?one|citi|citibank|svb|silicon valley bank|brex|wise|transferwise|venmo|zelle|paypal|cash ?app|ally|discover|marcus|wealthfront|betterment|e\*?trade|interactive brokers|ibkr)\b|bank|credit union|brokerage/i;
const HOSTS = /bank|creditunion|brokerage/i;

// Bitwarden saves Android apps as android://<cert hash>@com.paypal.android.p2pmobile/ (or androidapp://...): that is paypal.com.
const host = (u) => {
	const app = /^android(?:app)?:\/\/(?:[^@/]*@)?([^/]+)/i.exec(u);
	if (app) return app[1].split(".").slice(0, 2).reverse().join(".");
	try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`).hostname; } catch { return String(u); }
};
const hosts = (i) => [...(i.login?.uris ?? []).map((u) => u.uri), ...(i.login?.fido2Credentials ?? []).map((p) => p.rpId)].filter(Boolean).map(host);

/** Why an item is blocked, or undefined. Cards are blocked only by the folder: a card for a purchase is not money movement. */
export function blockReason(i, folderIds) {
	if (i.folderId && folderIds.has(i.folderId)) return `folder ${FOLDER}`;
	if (i.type === 3) return undefined;
	for (const h of hosts(i)) {
		const d = getDomain(h) ?? h;
		if (DOMAINS.has(d) || HOSTS.test(d)) return `domain ${d}`;
	}
	if (NAMES.test(i.name ?? "")) return "name";
	return undefined;
}

export const blockedFolderIds = (folders) => new Set(folders.filter((f) => f.name === FOLDER || f.name?.startsWith(`${FOLDER}/`)).map((f) => f.id));

export class Blocked extends Error {
	constructor(ref) { super(`${ref}: blocked by Raunak's vault blocklist (folder "${FOLDER}" or banks/money list). raubot never gets this item; ask Raunak to do it himself.`); }
}
