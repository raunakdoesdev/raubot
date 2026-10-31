#!/bin/sh
# Live E2E for one-tap pairing on staging. PUBLIC=1 redeems with no Access headers (needs the Access bypass on /api/pair/redeem).
# Run: vault run --env CF_ID=bw://c4a2aaeb-3f65-4339-806a-b4eb008825ef/username --env CF_SECRET=bw://c4a2aaeb-3f65-4339-806a-b4eb008825ef/password -- sh raubot/test/pair-e2e.sh
set -u
B=https://raubot-staging.example.com
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1 ($2)"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }
if [ "${PUBLIC:-0}" = 1 ]; then set -- ; else set -- -H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET"; fi
redeem() { curl -s -o /tmp/pair.$$ -w '%{http_code}' -X POST "$B/api/pair/redeem" "$@" -H 'content-type: application/json' --data "$BODY"; }
LINK=$(/workspace/bin/raubot-pair-link)
CODE=$(printf %s "$LINK" | sed -E 's/.*code=//')
check "link base" "$(printf %s "$LINK" | sed -E 's/&code=.*//')" "raubot://pair?base=https%3A%2F%2Fraubot-staging.example.com"
BODY="{\"code\":\"$CODE\",\"device_name\":\"e2e\"}"
check "redeem" "$(redeem "$@")" 200
eval "$(python3 -c "import json,shlex;d=json.load(open('/tmp/pair.$$'));print(' '.join('R_%s=%s'%(k,shlex.quote(v)) for k,v in d.items()))")"
check "base_url" "$R_base_url" "$B"
check "redeem again" "$(redeem "$@")" 410
BODY='{"code":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'
check "bogus code" "$(redeem "$@")" 400
check "creds work on /tasks.json" "$(curl -s -o /dev/null -w '%{http_code}' "$B/tasks.json" -H "CF-Access-Client-Id: $R_cf_access_client_id" -H "CF-Access-Client-Secret: $R_cf_access_client_secret" -H "Authorization: Bearer $R_app_token")" 200
check "mint without Access" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/pair/new")" 302
check "mint without app token" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/pair/new" -H "CF-Access-Client-Id: $R_cf_access_client_id" -H "CF-Access-Client-Secret: $R_cf_access_client_secret")" 401
rm -f /tmp/pair.$$
exit $fail
