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

## Second cause: the wrong account

After the headless fix, staging runs on 3 boxes got no CAPTCHA, but Google signed in as sauhaarda@gmail.com every time, even after "Use another account". The vault has several google.com passkeys, and the virtual authenticator approves without a prompt. Google's passkey autofill on the email page used the first discoverable one before an email was typed.

## Fix

- `launch.mjs` starts Xvfb and runs the same Chromium with `headless: false`. The profile and cookie jar do not change. The user agent is not spoofed and the CAPTCHA is not solved.
- `passkeys.mjs` makes a passkey non-discoverable when its site has more than one passkey in the vault. The site must then ask for the email first, and Google requests the passkey of that account. Sites with one passkey keep usernameless sign-in.

Vercel SAML needs raunak@reducto.ai. Google Admin needs admin-raunak@reducto.ai.

## Results on staging (3 boxes, commit ccbaed6)

- No CAPTCHA and no headless user agent in any run.
- raunak@reducto.ai: Google SAML for Vercel completed with the correct account (Google passkey, then Duo passkey). The other 2 boxes reused that Vercel session and loaded the members page.
- admin-raunak@reducto.ai: sign-in worked, then Google showed "Your domain requires enrollment in 2-step verification". This is an account setting, so the run stopped there.

## Remaining risk

On 2 of the 3 boxes, admin.google.com returned `/sorry/index` ("unusual traffic from your computer network") before sign-in. Google listed two different addresses, for example `104.28.153.8 ≠ 2a09:bac1:...`, so it saw both the box's IPv4 and its IPv6 Cloudflare egress. This comes from the network, not the browser. The fix for it is to send Google sign-ins through a trusted host such as the Mac mini.
