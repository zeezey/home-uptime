#!/usr/bin/env bash
# Check every target; write the names of the ones that are down to down.txt.
# A target is down only if it fails THREE times, 20 s apart -- one dropped
# packet should not wake anyone up.
set -uo pipefail

: > down.txt
while read -r name url want; do
  [[ -z "${name:-}" || "$name" == \#* ]] && continue
  ok=0
  for attempt in 1 2 3; do
    body=$(curl -fsS --max-time 20 -A "home-uptime (github actions)" "$url" 2>/dev/null) && [[ "$body" == *"$want"* ]] && { ok=1; break; }
    [[ $attempt -lt 3 ]] && sleep 20
  done
  if [[ $ok == 1 ]]; then echo "up    $name"; else echo "DOWN  $name  ($url)"; echo "$name" >> down.txt; fi
done < <(sed 's/  */ /g' targets.txt | awk 'NF>=3 {printf "%s %s %s", $1, $2, $3; for (i=4;i<=NF;i++) printf " %s", $i; print ""}')
