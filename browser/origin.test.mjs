// The origin check on vault fill/type: values go only to pages on the item's saved site, including inside frames and on lookalike domains.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fillUrls, sameSite, typeUrls } from "./origin.mjs";

test("sameSite compares registrable domains", () => {
	const g = ["https://accounts.google.com"];
	assert.ok(sameSite(["https://accounts.google.com/signin"], g));
	assert.ok(sameSite(["https://myaccount.google.com/"], g));
	assert.ok(sameSite(["https://a.example.co.uk/x"], ["example.co.uk"]));
	assert.ok(sameSite(["http://localhost:8080/login"], ["http://localhost:3000"]));
	for (const bad of ["https://accounts.google.com.evil.io/", "https://accounts-google.com/", "https://googIe.com/", "https://google.co/", "https://xn--ggle-0nda.com/", "about:blank", "data:text/html,x", "file:///etc/passwd", "javascript:alert(1)"])
		assert.ok(!sameSite([bad], g), bad);
	assert.ok(!sameSite(["https://b.example.co.uk/"], ["other.co.uk"]));
	assert.ok(!sameSite(["https://evil.io/"], []), "no saved uri means no fill");
	assert.ok(!sameSite([], g));
	assert.ok(!sameSite(["https://accounts.google.com/", "https://evil.io/frame"], g), "every url must match");
});

test("fill and type see the frame that gets the value", async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.route("https://**/*", (r) => {
			const u = new URL(r.request().url());
			const body = u.hostname === "login.example.com" ? `<input id=p type=password><iframe src="https://evil.io/frame"></iframe>` : `<input id=q type=password>`;
			return r.fulfill({ contentType: "text/html", body });
		});
		const saved = ["https://login.example.com"];
		await page.goto("https://login.example.com/");
		assert.ok(sameSite(await fillUrls(page, page.locator("#p")), saved));
		const framed = page.frameLocator("iframe").locator("#q");
		assert.ok(!sameSite(await fillUrls(page, framed), saved), "an attacker frame on the right page is refused");
		await page.locator("#p").focus();
		assert.ok(sameSite(await typeUrls(page), saved));
		await framed.focus();
		assert.ok(!sameSite(await typeUrls(page), saved), "typing into a focused attacker frame is refused");
		await page.goto("https://login.examp1e.com/");
		assert.ok(!sameSite(await fillUrls(page, page.locator("#q")), saved), "lookalike domain is refused");
		assert.ok(!sameSite(await typeUrls(page), saved));
	} finally { await browser.close(); }
});
