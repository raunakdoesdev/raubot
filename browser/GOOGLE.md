# Google sign-in from the box browser

## Symptom

Google sign-ins from the box browser (Vercel SAML, admin.google.com, Tailscale, Iru) showed CAPTCHA loops, a passkey step that returned HTTP 500, and then "This browser or app may not be secure".

## Root cause

The browser ran headless. Headless Chromium sends `HeadlessChrome/<version>` in its user agent. Google gives that browser the "Lite" sign-in flow (`flowName=WebLiteSignIn`). That flow asks for a CAPTCHA before the password or passkey step. It ends in "This browser or app may not be secure", or in a 500 at the passkey step.

Test: open the Google identifier page for raunak@reducto.ai on a staging box (Cloudflare egress, AS13335) and enter the email. Change only the browser mode:

| Browser | Sign-in flow | Result |
| --- | --- | --- |
| Playwright Chromium, headless (old) | `WebLiteSignIn` | CAPTCHA |
| Playwright Chromium, headed on Xvfb (new) | `GlifWebSignIn` | passkey challenge, no CAPTCHA |

The local VM gave the same results, and branded Google Chrome gave the same results as Chromium. These do not cause the problem:

- The egress IP. The headed browser on the same Cloudflare IP got the normal flow.
- `navigator.webdriver`. It was already `false` because of `--disable-blink-features=AutomationControlled`.
- The cookie jar. Google cookies already sync between boxes. A synced session does not help when every new sign-in goes to the Lite flow.

## Fix

`launch.mjs` starts Xvfb and runs the same Chromium with `headless: false`. The profile, cookie jar and Bitwarden passkeys do not change. The user agent is not spoofed and the CAPTCHA is not solved.

The account must sign in with the right identity. Vercel SAML needs raunak@reducto.ai and Google Admin needs admin-raunak@reducto.ai. If Google shows the wrong account, use "Use another account" or the account chooser.
