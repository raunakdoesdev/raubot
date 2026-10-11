#!/bin/bash
# Run as root on a clean Boat sandbox by build.ts, with this directory copied to /home/user/.raubot-template.
set -euo pipefail
cd "$(dirname "$0")"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
command -v jq >/dev/null || apt-get install -y -qq jq >/dev/null
apt-get install -y -qq --no-install-recommends $(jq -r '.apt | join(" ")' manifest.json) >/dev/null
install -d /opt/raubot
install -m 0644 boatd.mjs manifest.json /opt/raubot/
install -m 0755 firewall.sh /opt/raubot/
install -m 0644 raubot-boatd.service raubot-firewall.service /etc/systemd/system/
# The box's commands run as `user`; browser/ links its `vault` CLI into /usr/local/bin.
chown user:user /usr/local/bin
# The browser uses the preinstalled Chrome on the real desktop, so Playwright's Chromium download is skipped.
install -d -o user -g user /home/user/.raubot /home/user/workspace
touch /home/user/.raubot/chromium && chown user:user /home/user/.raubot/chromium
# Nothing typed into a page is saved by Chrome: no password manager, no autofill.
for d in /etc/opt/chrome/policies/managed /etc/chromium/policies/managed; do
	install -d "$d"
	echo '{"PasswordManagerEnabled":false,"PasswordLeakDetectionEnabled":false,"AutofillAddressEnabled":false,"AutofillCreditCardEnabled":false}' > "$d/raubot.json"
done
# The journal stays in memory, and shells keep no history.
install -d /etc/systemd/journald.conf.d && printf '[Journal]\nStorage=volatile\n' > /etc/systemd/journald.conf.d/raubot.conf
systemctl restart systemd-journald && rm -rf /var/log/journal/*
# Boat ships a 2 GB /swapfile on the root disk; swapped-out memory (vault values, tmpfs pages) would land on disk.
swapoff -a; sed -i '/swapfile/d' /etc/fstab; systemctl mask swapfile.swap >/dev/null 2>&1; rm -f /swapfile
echo 'vm.swappiness=0' > /etc/sysctl.d/90-raubot-noswap.conf
grep -q 'HISTFILE=/dev/null' /etc/bash.bashrc || echo 'HISTFILE=/dev/null' >> /etc/bash.bashrc
git config --system user.name raubot && git config --system user.email raubot@reducto.ai && git config --system init.defaultBranch main
systemctl daemon-reload
systemctl enable --now raubot-firewall.service raubot-boatd.service
sleep 1
curl -fsS http://127.0.0.1:8912/health
curl -fsS -m 10 -o /dev/null -w 'egress https %{http_code}\n' https://github.com
! curl -fsS -m 5 -o /dev/null http://169.254.169.254/ 2>/dev/null || { echo "metadata reachable" >&2; exit 1; }
echo template ok
