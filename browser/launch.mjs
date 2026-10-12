// Launches the box's Chromium headed on a virtual display (Xvfb), or on a Boat box its Chrome on the desktop.
// Headless Chromium says "HeadlessChrome" in its user agent, and Google answers that with a CAPTCHA-gated "Lite" sign-in
// (flowName=WebLiteSignIn, whose passkey step 500s) or "This browser or app may not be secure". Headed, it gets the normal sign-in. See browser/GOOGLE.md.
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright";

export const VIEWPORT = { width: 1440, height: 900 };

/** RAUBOT_VOLATILE (tmpfs on Boat) holds the profile's tab-restore and sessionStorage files, which keep values typed into forms. Cookies and local storage stay in the profile. */
function volatile(dir) {
	const to = process.env.RAUBOT_VOLATILE;
	if (!to) return;
	for (const d of ["Sessions", "Session Storage"]) {
		const at = `${dir}/Default/${d}`;
		fs.mkdirSync(`${to}/${d}`, { recursive: true });
		if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
		fs.rmSync(at, { recursive: true, force: true });
		fs.mkdirSync(`${dir}/Default`, { recursive: true });
		fs.symlinkSync(`${to}/${d}`, at);
	}
}

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
	volatile(dir);
	return chromium.launchPersistentContext(dir, {
		// On a Boat box: its preinstalled Chrome on the real desktop (RAUBOT_DISPLAY), which Boat can stream.
		channel: process.env.RAUBOT_CHROME ?? "chromium", headless: false, viewport: VIEWPORT, deviceScaleFactor: 1,
		env: { ...process.env, DISPLAY: process.env.RAUBOT_DISPLAY ?? (await xvfb()) },
		args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", `--window-size=${VIEWPORT.width},${VIEWPORT.height + 140}`],
		...options,
	});
}
