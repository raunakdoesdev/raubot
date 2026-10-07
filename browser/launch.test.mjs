// node browser/launch.test.mjs: needs Playwright's Chromium (and Xvfb, which launch.mjs installs if missing).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, xvfb, VIEWPORT } from "./launch.mjs";

delete process.env.DISPLAY;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raubot-launch-"));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(`${dir}/SingletonLock`, "stale"); // left behind by the box this one was copied from

const ctx = await launch(dir);
try {
	assert.match(await xvfb(), /^:\d+$/);
	assert.equal(await xvfb(), await xvfb(), "one Xvfb per process");
	assert.ok(fs.lstatSync(`${dir}/SingletonLock`).isSymbolicLink(), "stale lock replaced by Chromium's own");
	const page = ctx.pages()[0] ?? (await ctx.newPage());
	await page.setContent("<p>hi</p>");
	const fp = await page.evaluate(() => ({
		ua: navigator.userAgent,
		webdriver: navigator.webdriver,
		inner: [innerWidth, innerHeight],
		outer: [outerWidth, outerHeight],
	}));
	// Google gives "HeadlessChrome" the CAPTCHA-gated Lite sign-in (see GOOGLE.md).
	assert.doesNotMatch(fp.ua, /Headless/);
	assert.equal(fp.webdriver, false);
	assert.deepEqual(fp.inner, [VIEWPORT.width, VIEWPORT.height]);
	assert.ok(fp.outer[1] > fp.inner[1], "a real window has browser chrome around the page");
	console.log("launch ok", fp.ua);
} finally {
	await ctx.close();
	fs.rmSync(dir, { recursive: true, force: true });
}
