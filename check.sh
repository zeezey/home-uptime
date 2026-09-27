#!/usr/bin/env bash
# Check every target; write the names of the ones that are down to down.txt.
# A target is down only if it fails THREE times, 20 s apart -- one dropped
# packet should not wake anyone up.
set -uo pipefail

: > down.txt

# The listing sites sit behind Cloudflare with Bot Fight Mode on, which
# challenges any datacenter -- GitHub's included -- and cannot be exempted on
# the free plan. So they are checked DIRECTLY at the house (the home IP that
# zeezey.duckdns.org follows), with their real hostname, and TLS still verified
# against Cloudflare's Origin CA -- the CA that signed the origin certificate.
# That is the failure this monitor exists for: the house or the server down.
ORIGIN_IP=$(getent ahostsv4 zeezey.duckdns.org | awk 'NR==1 {print $1}')
direct() { # extra curl args for a URL that must bypass Cloudflare
  local host; host=$(sed -E 's#^https?://([^/:]+).*#\1#' <<<"$1")
  if [[ "$host" == *.tucsonexperts.com && -n "$ORIGIN_IP" ]]; then
    echo "--resolve $host:443:$ORIGIN_IP --cacert cf-origin-ca.pem"
  fi
}

while read -r name url want; do
  [[ -z "${name:-}" || "$name" == \#* ]] && continue
  ok=0
  for attempt in 1 2 3; do
    # shellcheck disable=SC2046
    body=$(curl -fsS --max-time 20 -A "home-uptime (github actions)" $(direct "$url") "$url" 2>/dev/null) && [[ "$body" == *"$want"* ]] && { ok=1; break; }
    [[ $attempt -lt 3 ]] && sleep 20
  done
  if [[ $ok == 1 ]]; then
    echo "up    $name"
  else
    # Say WHY: a status code and Cloudflare's own verdict header separate "the
    # house is down" (522/523/timeout) from "Cloudflare challenged the
    # monitor" (403 + cf-mitigated: challenge).
    # shellcheck disable=SC2046
    why=$(curl -sS -o /dev/null --max-time 20 -A "home-uptime (github actions)" $(direct "$url") -D - -w 'status=%{http_code}' "$url" 2>&1 \
      | grep -iE '^cf-mitigated|^server:|status=' | tr -d '\r' | paste -sd ' ')
    echo "DOWN  $name  ($url)  $why"
    echo "$name" >> down.txt
  fi
done < <(sed 's/  */ /g' targets.txt | awk 'NF>=3 {printf "%s %s %s", $1, $2, $3; for (i=4;i<=NF;i++) printf " %s", $i; print ""}')
