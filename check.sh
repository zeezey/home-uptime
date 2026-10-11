#!/usr/bin/env bash
# Check every target. Writes the names that are down to down.txt, and the names that could NOT be checked from
# here this run to unknown.txt (the workflow keeps their last state: an unknown is neither down nor back up).
#
# Two sources of targets:
#   - targets.txt: fixed things (the launcher, the other products). <name> <url> <text the answer must contain>
#   - the listing server's own /__sites: every listing with a published release.
#     Publishing a listing adds it here and retiring one removes it -- nobody
#     keeps a list. The last list seen is kept in sites.txt, so when the house
#     is down (and cannot say what is live) the monitor still checks, and still
#     alerts on, the sites that were live a moment ago.
#
# A target is down only if it fails THREE times, 20 s apart -- one dropped
# packet should not wake anyone up. All targets are checked at once, so an
# outage of every target still takes about a minute and a half, not one and a
# half minutes per target (the job has 8).
set -uo pipefail

DOMAIN=tucsonexperts.com
UA="home-uptime (github actions)"
RETRY_SLEEP=${RETRY_SLEEP:-20} # seconds between tries (the tests set 0)
: > down.txt
: > unknown.txt

# The listing sites sit behind Cloudflare with Bot Fight Mode on, which
# challenges any datacenter -- GitHub's included -- and cannot be exempted on
# the free plan. So they are checked DIRECTLY at the house (the home IP that
# zeezey.duckdns.org follows), with their real hostname, and TLS still verified
# against Cloudflare's Origin CA -- the CA that signed the origin certificate.
# That is the failure this monitor exists for: the house or the server down.
#
# If DuckDNS doesn't answer, there is no way to reach them past the challenge:
# through Cloudflare every listing would "fail" on the challenge and look down.
# So they are UNKNOWN this run, and the log says why.
ORIGIN_IP=$(getent ahostsv4 zeezey.duckdns.org 2>/dev/null | awk 'NR==1 {print $1}')
if [[ -n "$ORIGIN_IP" ]]; then
  echo "zeezey.duckdns.org -> $ORIGIN_IP: the listing sites are checked there, directly"
else
  echo "zeezey.duckdns.org did not resolve: the listing sites can't be checked at the house this run;"
  echo "  they are UNKNOWN, not down (through Cloudflare, Bot Fight Mode would challenge this runner)"
fi

host_of() { sed -E 's#^https?://([^/:]+).*#\1#' <<<"$1"; }
at_house() { [[ "$(host_of "$1")" == *."$DOMAIN" ]]; } # a URL that must be checked at the house
direct() { # extra curl args for such a URL
  if at_house "$1" && [[ -n "$ORIGIN_IP" ]]; then
    echo "--resolve $(host_of "$1"):443:$ORIGIN_IP --cacert cf-origin-ca.pem"
  fi
}

# ---- which listings are live ------------------------------------------------
touch sites.txt
LIST_URL="https://sites.$DOMAIN/__sites"
read_list() {
  # shellcheck disable=SC2046
  curl -fsS --max-time 20 -A "$UA" $(direct "$LIST_URL") "$LIST_URL" 2>/dev/null | jq -er '.sites[]' 2>/dev/null | tr -d '\r'
}
if [[ -z "$ORIGIN_IP" ]]; then
  echo "the live list can't be read without the house's IP -- checking the last known one: $(paste -sd ' ' sites.txt)"
elif live=$(read_list) || { sleep "$RETRY_SLEEP"; live=$(read_list); }; then
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

# One target: prints "<up|down|unknown><TAB><name><TAB><detail>". $4 is a scratch-file prefix of its own.
check_one() {
  local name=$1 url=$2 want=$3 tmp=$4 attempt code why
  if at_house "$url" && [[ -z "$ORIGIN_IP" ]]; then
    printf 'unknown\t%s\t(%s) not checked: zeezey.duckdns.org did not resolve\n' "$name" "$url"
    return
  fi
  for attempt in 1 2 3; do
    : > "$tmp.h"
    : > "$tmp.b"
    # shellcheck disable=SC2046
    code=$(curl -sS --max-time 20 -A "$UA" $(direct "$url") -D "$tmp.h" -o "$tmp.b" -w '%{http_code}' "$url" 2>"$tmp.e")
    if [[ "$code" == 200 ]] && grep -qF -- "$want" "$tmp.b"; then
      printf 'up\t%s\t\n' "$name"
      return
    fi
    # Cloudflare challenged THIS runner (Bot Fight Mode, on the website's zone): that says nothing about the site.
    if [[ "$code" == 403 ]] && grep -qiE '^cf-mitigated: *challenge' "$tmp.h"; then
      printf 'unknown\t%s\t(%s) not checked: Cloudflare challenged the runner (cf-mitigated: challenge)\n' "$name" "$url"
      return
    fi
    [[ $attempt -lt 3 ]] && sleep "$RETRY_SLEEP"
  done
  # Say WHY: a status code and Cloudflare's own verdict header separate "the
  # house is down" (timeout / 5xx) from everything else.
  why="status=$code"
  [[ "$code" == 200 ]] && why="$why but \"$want\" is not in the answer"
  why="$why $(grep -iE '^(cf-mitigated|server):' "$tmp.h" | tr -d '\r' | paste -sd ' ') $(head -c 200 "$tmp.e" | tr -d '\r\n')"
  printf 'down\t%s\t(%s) %s\n' "$name" "$url" "$why"
}

work=$(mktemp -d)
n=0
while read -r name url want; do
  [[ -z "${name:-}" ]] && continue
  n=$((n + 1))
  check_one "$name" "$url" "$want" "$work/$n" > "$work/$n.res" &
done < all-targets.txt
wait

for ((i = 1; i <= n; i++)); do
  state='' name='' detail=''
  IFS=$'\t' read -r state name detail < "$work/$i.res"
  case $state in
    up) echo "up       $name" ;;
    down) echo "DOWN     $name  $detail"; echo "$name" >> down.txt ;;
    unknown) echo "unknown  $name  $detail"; echo "$name" >> unknown.txt ;;
    *) echo "unknown  (target $i: its check left no result)" ;;
  esac
done
rm -rf "$work" all-targets.txt
