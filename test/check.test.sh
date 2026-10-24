#!/usr/bin/env bash
# Tests for check.sh (the GitHub workflow's checker) and the workflow's state merge, against a fake curl and getent
# (test/fake-bin): no real network. Run: bash test/check.test.sh -- exits non-zero on any failure.
set -uo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
fails=0
pass() { echo "ok    $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }
expect() { # <description> <command...>: passes when the command succeeds
  local what=$1; shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}

# A scratch copy of the repo's checker, with a small targets.txt and a fake web.
setup() {
  box=$(mktemp -d)
  cp "$repo/check.sh" "$repo/cf-origin-ca.pem" "$box/"
  mkdir -p "$box/web"
  cat > "$box/targets.txt" <<'EOF'
# fixed targets
launcher   https://launcher.example.org/login   Listing Launcher
shop       https://shop.example.com/api/healthz "ok":true
website    https://tucsonexperts.com/           Tucson Experts
EOF
  printf 'a-1\nb-2\n' > "$box/sites.txt"
  web() { printf '%s\n%s\n%s' "$2" "$3" "$4" > "$box/web/$1"; } # <host> <code> <header line> <body>
}
run_check() { # [origin ip]
  (cd "$box" && PATH="$repo/test/fake-bin:$PATH" FAKE_WEB="$box/web" FAKE_LOG="$box/requests.log" \
    FAKE_ORIGIN_IP="${1:-}" RETRY_SLEEP=0 bash check.sh > "$box/out.log" 2>&1)
}
lines() { [[ -f "$1" ]] && sort "$1" | paste -sd ' ' || true; }
hits() { grep -c "^$1" "$box/requests.log" || true; }

# --- DuckDNS doesn't resolve: the listings are UNKNOWN (and logged as such), never down ----------------------------
setup
web launcher.example.org 200 '' '<title>Listing Launcher</title>'
web shop.example.com 200 '' '{"ok":true}'
web tucsonexperts.com 200 '' '<title>Tucson Experts</title>'
run_check ""
expect "no IP: the log says DuckDNS did not resolve" grep -q "zeezey.duckdns.org did not resolve" "$box/out.log"
expect "no IP: nothing is down" test "$(lines "$box/down.txt")" = ""
expect "no IP: both listings are unknown" test "$(lines "$box/unknown.txt")" = "a-1 b-2"
expect "no IP: the listings were not fetched through Cloudflare" test "$(hits https://a-1.)$(hits https://b-2.)$(hits https://sites.)" = "000"
expect "no IP: the last list is kept" test "$(lines "$box/sites.txt")" = "a-1 b-2"
expect "no IP: the other targets are still checked and up" grep -qE '^up +launcher' "$box/out.log"
rm -rf "$box"

# --- DuckDNS resolves: logged; listings checked at that IP; challenge = unknown; failures retried 3 times --------
setup
web sites.tucsonexperts.com 200 '' '{"sites":["a-1","c-3"]}'
web a-1.tucsonexperts.com 200 '' '<html><title>A</title>'
web c-3.tucsonexperts.com 404 '' '<title>Not available</title>'
web launcher.example.org 200 '' '<title>Listing Launcher</title>'
web shop.example.com 200 '' '{"ok":false}'
web tucsonexperts.com 403 'cf-mitigated: challenge' 'Just a moment...'
run_check 203.0.113.7
expect "IP: the log names the resolved IP" grep -q "zeezey.duckdns.org -> 203.0.113.7" "$box/out.log"
expect "IP: the live list replaces the last one" test "$(lines "$box/sites.txt")" = "a-1 c-3"
expect "IP: listings are fetched at the house's IP" grep -q "^https://a-1.tucsonexperts.com/ a-1.tucsonexperts.com:443:203.0.113.7$" "$box/requests.log"
expect "IP: down = the 404 listing and the wrong answer" test "$(lines "$box/down.txt")" = "c-3 shop"
expect "IP: a Cloudflare challenge is unknown, not down" test "$(lines "$box/unknown.txt")" = "website"
expect "IP: a challenge is not retried" test "$(hits https://tucsonexperts.com/)" = "1"
expect "IP: a failing target is tried 3 times" test "$(hits https://shop.example.com/)" = "3"
expect "IP: a passing target is tried once" test "$(hits https://launcher.example.org/)" = "1"
expect "IP: the down line says why" grep -qF 'status=200 but ""ok":true" is not in the answer' "$box/out.log"
expect "IP: the results come out in the targets' order" test "$(grep -oE '^(up|DOWN|unknown) +[a-z0-9-]+' "$box/out.log" | awk '{print $2}' | paste -sd ' ')" = "launcher shop website a-1 c-3"
rm -rf "$box"

# --- the workflow's merge: an unknown target keeps its last state ---------------------------------------------------
box=$(mktemp -d)
merge=$(grep -F 'comm -12 - was.txt' "$repo/.github/workflows/uptime.yml" | sed -E 's/^ +//')
expect "the workflow has the merge line" test -n "$merge"
(
  cd "$box" || exit 1
  printf 'a-1\nshop\n' > was.txt     # told down last run
  printf 'c-3\n' > now.txt           # down this run
  printf 'a-1\nwebsite\n' > unknown.txt # not checked this run
  eval "$merge"
  [[ "$(paste -sd ' ' now.txt)" == "a-1 c-3" ]]
)
expect "merge: a down target that is now unknown stays down; an unknown one that was up is not down" test $? -eq 0
rm -rf "$box"

# --- the workflow's alerts: a failed alert is not recorded as told, so the next run sends it again -------------------
# Runs the "Alert and record" step's script from `touch status.txt` to the status.txt write, with the fake curl.
step=$(awk '/touch status.txt unknown.txt/ {on=1} on {print} /-o status.txt/ {exit}' "$repo/.github/workflows/uptime.yml" | sed -E 's/^ {10}//')
expect "the workflow has the alert step" grep -q 'sort -u told.txt -o status.txt' <<<"$step"
alert_run() { # <ntfy answers: up|refuses> <was> <down now>: prints status.txt afterwards
  local b; b=$(mktemp -d)
  mkdir -p "$b/web"
  [[ $1 == up ]] && printf '200\n\n' > "$b/web/ntfy.example"
  printf '%s' "$2" | tr ' ' '\n' | sed '/^$/d' > "$b/status.txt"
  printf '%s' "$3" | tr ' ' '\n' | sed '/^$/d' > "$b/down.txt"
  (cd "$b" && PATH="$repo/test/fake-bin:$PATH" FAKE_WEB="$b/web" FAKE_LOG="$b/requests.log" \
    ALERT_WEBHOOK=https://ntfy.example/topic bash -e -c "$step" > /dev/null 2>&1) || echo "step failed"
  paste -sd ' ' "$b/status.txt"
  rm -rf "$b"
}
expect "alerts delivered: status.txt is the new down-list" test "$(alert_run up 'a-1 shop' 'c-3 shop')" = "c-3 shop"
expect "DOWN alert refused: the new one is not recorded (re-sent next run)" test "$(alert_run refuses 'shop' 'c-3 shop')" = "shop"
expect "back-up alert refused: the recovered one stays recorded (re-sent next run)" test "$(alert_run refuses 'a-1 shop' 'shop')" = "a-1 shop"

echo
if [[ $fails -gt 0 ]]; then echo "$fails failed"; exit 1; fi
echo "all passed"
