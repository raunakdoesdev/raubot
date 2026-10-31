#!/bin/sh
# Publishes Cloudflare Artifacts main to the public GitHub repo (origin main) as one commit: the same tree without
# private paths, deployment identifiers replaced by placeholders, and the public README and .dev.vars.example kept.
# Usage: sh scripts/publish-github.sh [ref]   (ref defaults to artifacts/main; DRY=1 builds and checks without pushing)
set -eu
ref=${1:-artifacts/main}
repo=$(git rev-parse --show-toplevel)
cd "$repo"
git fetch -q origin main
tmp=$(mktemp -d); idx=$tmp.index; trap 'rm -rf "$tmp" "$idx"' EXIT
git archive "$ref" | tar -x -C "$tmp"
acct=$(grep -oE 'registry\.cloudflare\.com/[0-9a-f]{32}' "$tmp/wrangler.jsonc" | head -1 | cut -d/ -f2)
team=$(grep -oE '"ACCESS_TEAM": *"[^"]+"' "$tmp/wrangler.jsonc" | head -1 | cut -d'"' -f4)
cd "$tmp"
rm -rf ios research browser/GOOGLE.md ./*.png
for f in README.md .dev.vars.example; do git -C "$repo" show "origin/main:$f" > "$f"; done
grep -rlIZ . --exclude=package-lock.json | xargs -0 sed -i -E \
	-e "s#registry\.cloudflare\.com/$acct/raubot-box@sha256:[0-9a-f]{64}#registry.cloudflare.com/YOUR_CLOUDFLARE_ACCOUNT_ID/raubot-box:YOUR_IMAGE_TAG#g" \
	-e "s/$acct/YOUR_CLOUDFLARE_ACCOUNT_ID/g" \
	-e 's/"ACCESS_AUD": *"[0-9a-f]{64}"/"ACCESS_AUD": "YOUR_ACCESS_AUD"/g' \
	-e "s/\"ACCESS_TEAM\": *\"$team\"/\"ACCESS_TEAM\": \"YOUR_ACCESS_TEAM\"/g" \
	-e 's/[A-Za-z0-9._%+-]+@gmail\.com/personal@example.com/g' \
	-e 's/example\.com/example.com/g' -e 's/reducto\\\.ai/example\\.com/g'
if grep -rnIE "$acct|\"$team\"|reducto\\\\?\.ai|@gmail\.com|bx_[a-z0-9]{8}" .; then echo "private identifiers left (above); not publishing" >&2; exit 1; fi
ln -s "$repo/node_modules" node_modules
npm run -s check && out=$(npm test 2>&1) || { echo "$out" >&2; exit 1; }
rm node_modules
cd "$repo"
GIT_INDEX_FILE=$idx git --work-tree="$tmp" add -A
tree=$(GIT_INDEX_FILE=$idx git write-tree)
[ "$tree" = "$(git rev-parse 'origin/main^{tree}')" ] && { echo "GitHub main is already up to date" >&2; exit 0; }
c=$(git commit-tree "$tree" -p origin/main -m "Sync with Cloudflare Artifacts main $(git rev-parse --short "$ref")" -m "$(git log -1 --format=%s "$ref")")
git diff --stat origin/main "$c" | tail -1
git push ${DRY:+--dry-run} origin "$c:refs/heads/main"
