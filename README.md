# home-uptime

An outside watcher for the sites that run from home: the Listing Launcher and
every listing site at `<slug>.tucsonexperts.com`.

The nightly audit runs on the same home server as the sites, so if the house
loses power or internet, nothing is left to notice. Two watchers run outside the house, and **both can alert**:

| | Cloudflare Worker (`worker/`) | GitHub workflow (`.github/workflows/uptime.yml`) |
|---|---|---|
| Runs | **every 5 minutes, on time** | scheduled every 10 min, but GitHub actually runs it every ~3–5 h |
| Checks | through Cloudflare, as a visitor does | directly at the house (GitHub is challenged by Bot Fight Mode) |
| State | KV namespace `home-uptime-state`, key `state` | `status.txt` in this repo |
| Live view | https://home-uptime.zeezey.workers.dev/status | the Actions tab |

## The Cloudflare Worker (since 2026-10-03)

`worker/` is a Cloudflare Worker named `home-uptime` with a cron trigger `*/5 * * * *`. Each run does what
`check.sh` does — the launcher from `targets.txt` (inlined at build time, so it stays the one list) plus every
live listing from the listing server's `/__sites` (last list kept as the fallback), 200 **and** the expected text,
3 tries 20 s apart — and alerts on the same rules: on going down, hourly while down, once on recovery.

- **Bot Fight Mode does not challenge a Worker's fetch** (measured: 200 with the real page on every target), so it
  checks through Cloudflare, and a dead house shows up as Cloudflare's 52x. `cache: "no-store"` keeps an edge copy
  from answering for a dead origin.
- **Alert channels, in order:** ntfy (secret `ALERT_WEBHOOK`, the launcher's `LAUNCHER_ALERT_WEBHOOK`), then
  Discord (secret `DISCORD_WEBHOOK`) if ntfy refuses. **Anonymous ntfy.sh refuses Workers**: its daily quota is per
  IP and Workers share Cloudflare's IPs (`429 daily message quota reached`, 0 of 8 accepted). Fix it with an ntfy.sh
  account token as secret `NTFY_TOKEN` (sent as `Authorization: Bearer`), or set `DISCORD_WEBHOOK`. Until one of
  those is set, **the Worker detects outages but cannot deliver alerts** — the GitHub workflow still can.
- **Secrets** live only on Cloudflare: dashboard → Workers & Pages → `home-uptime` → Settings → Variables and
  Secrets (or `cf workers secrets update`). Secrets added there survive later deploys (tested).
- **Test alert:** put any value under the KV key `test-alert` (`cf kv keys put test-alert --namespace-id
  79a73c9095ed43d98ec3d51b3a793b51 --body yes`); the next run sends one test alert and deletes the key once it is
  delivered (a refused one is retried every run).
- **Logs:** Workers Logs is on (3 days): each run's `up`/`DOWN` lines and every alert's channel and result —
  dashboard → `home-uptime` → Logs, or `cf observability telemetry query`.
- **Deploy:** `cd worker && npm install && npm test && npx cf deploy` (the `cf` CLI, OAuth-logged in on the PC).
  Free-plan budget: one KV write per run = 288 a day (limit 1,000).

## The GitHub workflow

Scheduled every 10 minutes (GitHub runs it far less often):

- checks the launcher (`targets.txt`) and every live listing (status 200 **and** the expected text on
  the page), retrying 3 times, 20 s apart, before calling anything down;
- sends a phone alert (ntfy) when something **goes down**, again **hourly** while
  it stays down, and once when it **comes back**;
- keeps the current down-list in `status.txt` (committed only on a change).

The alert address is the repo secret `ALERT_WEBHOOK`; it is never in the code.
To prove delivery: Actions → uptime → Run workflow → tick *Send a test alert*.

**Listings need no upkeep.** Each run asks the listing server which listings
are live (`/__sites`): publishing one adds it, retiring one removes it. The last
list seen is kept in `sites.txt`, so if the house is down the monitor still checks
-- and alerts on -- what was live. `targets.txt` holds only fixed things (the launcher).

## Why the listing sites are checked at the house, not through Cloudflare

tucsonexperts.com has Cloudflare **Bot Fight Mode** on, which challenges every
datacenter (GitHub's included) and cannot be exempted on the free plan. So
`*.tucsonexperts.com` targets are fetched directly from the home IP that
`zeezey.duckdns.org` follows, with their real hostname, and TLS is verified
against Cloudflare's Origin CA root (`cf-origin-ca.pem`, valid to 2029-08-15 --
refresh it from developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem
before then). That catches exactly what this is for: the house or server down.
