// Launches the box's Chromium headed on a virtual display (Xvfb).
// Headless Chromium says "HeadlessChrome" in its user agent, and Google answers that with a CAPTCHA-gated "Lite" sign-in
// (flowName=WebLiteSignIn, whose passkey step 500s) or "This browser or app may not be secure". Headed, it gets the normal sign-in. See browser/GOOGLE.md.
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright";

export const VIEWPORT = { width: 1440, height: 900 };

let display;
/** Starts Xvfb once (installing it on first use) and returns its DISPLAY. Xvfb picks a free display number and exits with this process. */
export async function xvfb() {
	if (display) return display;
	try { execFileSync("sh", ["-c", "command -v Xvfb"]); }
	catch { execFileSync("sh", ["-c", "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb"], { stdio: ["ignore", 2, 2] }); }
	const x = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
	process.on("exit", () => x.kill());
	display = await new Promise((ok, fail) => {
		let s = "";
		x.stdio[3].on("data", (d) => { s += d; if (s.includes("\n")) { x.stdio[3].destroy(); x.unref(); ok(`:${s.trim()}`); } });
		x.on("exit", (code) => fail(new Error(`Xvfb exited (${code})`)));
	});
	return display;
}

/** The persistent context for the profile in `dir`. */
export async function launch(dir, options = {}) {
	fs.mkdirSync(dir, { recursive: true });
	// A box copied from a snapshot keeps the original box's Chromium locks; the caller is the profile's only user.
	for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) fs.rmSync(`${dir}/${f}`, { force: true });
	return chromium.launchPersistentContext(dir, {
		channel: "chromium", headless: false, viewport: VIEWPORT, deviceScaleFactor: 1,
		env: { ...process.env, DISPLAY: await xvfb() },
		args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", `--window-size=${VIEWPORT.width},${VIEWPORT.height + 140}`],
		...options,
	});
}
