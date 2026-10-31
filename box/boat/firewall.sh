#!/bin/bash
# Default-deny egress for the box, from manifest.json's "egress". Run as root at every boot (raubot-firewall.service):
# iptables rules don't survive a Boat stop/resume, which is a reboot.
set -euo pipefail
M=${1:-/opt/raubot/manifest.json}
tcp=$(jq -r '.egress.tcp | join(",")' "$M")
udp=$(jq -r '.egress.udp | join(",")' "$M")
deny=$(jq -r '.egress.deny[]' "$M")
# Boat's tunnel: WireGuard to the endpoint in wg0. Wait for it so the rule names the right address.
for i in $(seq 60); do WG=$(wg show wg0 endpoints 2>/dev/null | awk '{print $2}' | cut -d: -f1 | head -1); [ -n "$WG" ] && break; sleep 1; done
[ -n "${WG:-}" ] || { echo "no wg0 endpoint" >&2; exit 1; }
DNS=$(awk '/^nameserver/ && $2 !~ /:/ {print $2}' /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null | sort -u)

iptables -N RAUBOT-OUT 2>/dev/null || iptables -F RAUBOT-OUT
iptables -C OUTPUT -j RAUBOT-OUT 2>/dev/null || iptables -I OUTPUT 1 -j RAUBOT-OUT
A() { iptables -A RAUBOT-OUT "$@"; }
A -o lo -j ACCEPT
A -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
A -p udp -d "$WG" -j ACCEPT
A -o wg0 -j ACCEPT
A -p tcp --sport 8911 -j ACCEPT
for d in $DNS; do A -d "$d" -p udp --dport 53 -j ACCEPT; A -d "$d" -p tcp --dport 53 -j ACCEPT; done
for d in $deny; do A -d "$d" -j REJECT; done
A -p tcp -m multiport --dports "$tcp" -j ACCEPT
A -p udp -m multiport --dports "$udp" -j ACCEPT
A -j REJECT

ip6tables -N RAUBOT-OUT 2>/dev/null || ip6tables -F RAUBOT-OUT
ip6tables -C OUTPUT -j RAUBOT-OUT 2>/dev/null || ip6tables -I OUTPUT 1 -j RAUBOT-OUT
B() { ip6tables -A RAUBOT-OUT "$@"; }
B -o lo -j ACCEPT
B -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
B -o wg0 -j ACCEPT
B -p ipv6-icmp -j ACCEPT
B -p tcp --sport 8911 -j ACCEPT
B -p tcp -m multiport --dports "$tcp" -j ACCEPT
B -p udp -m multiport --dports "$udp" -j ACCEPT
B -j REJECT
echo "egress: tcp $tcp, udp $udp, wg $WG, dns ${DNS//$'\n'/ }"
