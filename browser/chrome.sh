#!/bin/sh
# Keeps Google Chrome on the latest stable release, which is where Chrome's security fixes ship (Playwright's bundled Chromium lags).
# Checks at most every 6 hours. After an update it stops the running browser, so the next call starts the new Chrome.
mark=~/.raubot/chrome-checked
[ -n "$(find "$mark" -mmin -360 2>/dev/null)" ] && exit 0
have=$(google-chrome-stable --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+){3}')
latest=$(curl -fsS -m 10 'https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions?pageSize=1' | jq -r '.versions[0].version')
[ -n "$have" ] && [ -z "$latest" ] && { echo "chrome $have: couldn't get the latest stable version" >&2; exit 0; }
mkdir -p ~/.raubot
[ "$have" = "$latest" ] && { touch "$mark"; exit 0; }
if [ -z "$have" ]; then npx playwright install --with-deps chrome || exit 1
else
	# A failed update leaves the current Chrome running and retries on the next call.
	(
		set -e
		as=; [ "$(id -u)" = 0 ] || as="sudo -n"
		deb=/tmp/google-chrome-stable.deb
		curl -fsSL -m 600 -o "$deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
		$as apt-get update -qq
		$as env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o DPkg::Lock::Timeout=300 "$deb"
		rm -f "$deb"
	) || { echo "chrome $have: update to $latest failed" >&2; exit 0; }
	pkill -TERM -f '[b]rowser/server.mjs' || true; pkill -TERM -x chrome || true
fi
echo "chrome ${have:-none} -> $(google-chrome-stable --version)" >&2
touch "$mark"
