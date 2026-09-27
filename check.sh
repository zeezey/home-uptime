#!/usr/bin/env bash
# Check every target; write the names of the ones that are down to down.txt.
#
# Two sources of targets:
#   - targets.txt: fixed things (the launcher). <name> <url> <text the page must contain>
#   - the listing server's own /__sites: every listing with a published release.
#     Publishing a listing adds it here and retiring one removes it -- nobody
#     keeps a list. The last list seen is kept in sites.txt, so when the house
#     is down (and cannot say what is live) the monitor still checks, and still
#     alerts on, the sites that were live a moment ago.
#
# A target is down only if it fails THREE times, 20 s apart -- one dropped
# packet should not wake anyone up.
set -uo pipefail

DOMAIN=tucsonexperts.com
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
  if [[ "$host" == *."$DOMAIN" && -n "$ORIGIN_IP" ]]; then
    echo "--resolve $host:443:$ORIGIN_IP --cacert cf-origin-ca.pem"
  fi
}

# ---- which listings are live ------------------------------------------------
touch sites.txt
LIST_URL="https://sites.$DOMAIN/__sites"
# shellcheck disable=SC2046
if live=$(curl -fsS --max-time 20 $(direct "$LIST_URL") "$LIST_URL" 2>/dev/null | jq -er '.sites[]' 2>/dev/null) || \
   { sleep 20; live=$(curl -fsS --max-time 20 $(direct "$LIST_URL") "$LIST_URL" 2>/dev/null | jq -er '.sites[]' 2>/dev/null); }; then
  printf '%s\n' "$live" | grep -E '^[a-z0-9-]+$' | sort -u > sites.new
  mv sites.new sites.txt
  echo "live listings: $(paste -sd ' ' sites.txt)"
else
  echo "could not read the live list -- checking the last known one: $(paste -sd ' ' sites.txt)"
fi

# ---- the combined target list -----------------------------------------------
{
  sed 's/  */ /g' targets.txt | awk 'NF>=3 && $1 !~ /^#/'
  # A live listing must answer 200 with its page shell; the "not available"
  # page for a missing site is a 404, so it never passes.
  while read -r slug; do [[ -n "$slug" ]] && echo "$slug https://$slug.$DOMAIN/ <title>"; done < sites.txt
} > all-targets.txt

while read -r name url want; do
  [[ -z "${name:-}" ]] && continue
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
    # house is down" (timeout / 5xx) from "Cloudflare challenged the monitor"
    # (403 + cf-mitigated: challenge).
    # shellcheck disable=SC2046
    why=$(curl -sS -o /dev/null --max-time 20 -A "home-uptime (github actions)" $(direct "$url") -D - -w 'status=%{http_code}' "$url" 2>&1 \
      | grep -iE '^cf-mitigated|^server:|status=' | tr -d '\r' | paste -sd ' ')
    echo "DOWN  $name  ($url)  $why"
    echo "$name" >> down.txt
  fi
done < all-targets.txt
rm -f all-targets.txt
