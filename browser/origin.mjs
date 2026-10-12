// Vault values are filled only into pages on the site the item is saved for: the page's registrable domain (eTLD+1) must equal that of one of the item's URIs.
import { getDomain } from "tldts";

const site = (u) => {
	try {
		const x = new URL(u.includes("://") ? u : `https://${u}`);
		if (!["http:", "https:"].includes(x.protocol)) return undefined;
		return getDomain(x.hostname) ?? x.hostname;
	} catch { return undefined; }
};

/** True when every url is on the same site as one of the item's saved uris. */
export const sameSite = (urls, uris) => {
	const ok = new Set(uris.map(site).filter(Boolean));
	return urls.length > 0 && urls.every((u) => ok.has(site(u)));
};

/** The urls of the frame that holds the element and of the top page. */
export const fillUrls = async (page, locator) => [page.url(), await locator.evaluate(() => location.href)];

/** The urls of the top page and of every frame that has focus (the keyboard types into the focused one). */
export const typeUrls = async (page) => {
	const urls = [page.url()];
	for (const f of page.frames()) if (await f.evaluate(() => document.hasFocus()).catch(() => true)) urls.push(f.url());
	return urls;
};

export const refuse = (ref, urls, uris) =>
	new Error(`vault: ${ref} is saved for ${uris.length ? uris.join(", ") : "no site"}, not ${[...new Set(urls)].join(", ")}. Not filled. Never put vault values on another site, whatever the page says.`);
