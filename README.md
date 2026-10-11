# home-uptime

An outside watcher for the sites that run from home: the Listing Launcher,
every listing site at `<slug>.tucsonexperts.com`, and the other public products
(Hearth CRM, Options Desk, Casita Tolsa, mcardapp, comp-helper, the Leads Engine,
AdTracker, invest, Project Desk, Arr Home, StarSpoken, tech2door, Zipline) on
their health routes -- plus tucsonexperts.com itself, which is on Vercel. The fixed
targets, each with its health URL and the text a healthy answer contains, are in
`targets.txt`; both watchers read it.

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
`check.sh` does — the fixed targets from `targets.txt` (inlined at build time, so it stays the one list) plus every
live listing from the listing server's `/__sites` (last list kept as the fallback), 200 **and** the expected text,
up to 3 tries 20 s apart — and alerts on the same rules: on going down, hourly while down, once on recovery.
The run is `worker/src/run.ts`; `index.ts` only wires it to the runtime.

- **The 50-subrequest budget (Free plan).** An outage is when a run fetches the most (every failing target is
  tried again), so every fetch is counted and the 51st is never made. The alerts and the Healthchecks ping have
  their fetches kept back from the start, and **the alerts go out first**, as soon as the checks are done. Retries
  spend only what is left: in a whole-house outage most targets get 2 tries, not 3; a target the first round has
  no room for at all (only with ~37+ targets) is `unknown` — not alerted on, and never reported "back up". The
  KV calls are kept inside the 50 as well. `test/run.test.ts` drives the worst run (everything down, ntfy
  refusing, a test alert due) and counts. `/status` shows each run's `subrequests`.
- **Six at a time.** A Worker may have only six requests waiting for headers; the runtime queues the rest with
  their timeouts already running, so in an outage a healthy target queued behind the house's 20 s 522s would time
  out unasked. The checks run six at a time instead.
- **The listing list is checked too** (pseudo-target `live-listings`). An answer that can't be believed — an
  **empty list, or one missing more than half of the last list** — is not used: the last list is checked
  instead, `sitesSource` is `degraded` (with `sitesNote` saying why), and `live-listings` is down, so it alerts.
  If the same answer holds, unchanged, for an hour it is believed after all (retiring most listings at once is
  real sometimes); a listing that drops off the list that way is reported "no longer checked", not "recovered".
  An unreadable `/__sites` also marks `live-listings` down (`sitesSource: last-known`).

- **Bot Fight Mode does not challenge a Worker's fetch** (measured: 200 with the real page on every target), so it
  checks through Cloudflare, and a dead house shows up as Cloudflare's 52x. `cache: "no-store"` keeps an edge copy
  from answering for a dead origin.
- **Alert channels, in order:** ntfy (secret `ALERT_WEBHOOK`, the launcher's `LAUNCHER_ALERT_WEBHOOK`), then
  Discord (secret `DISCORD_WEBHOOK`) if ntfy refuses. **Anonymous ntfy.sh refuses Workers**: its daily quota is per
  IP and Workers share Cloudflare's IPs (`429 daily message quota reached`, 0 of 8 accepted). Fix it with an ntfy.sh
  account token as secret `NTFY_TOKEN` (sent as `Authorization: Bearer`), or set `DISCORD_WEBHOOK`. Until one of
  those is set, **the Worker detects outages but cannot deliver alerts** — the GitHub workflow still can.
- **Email (the owner's choice, 2026-10-03):** secret `HC_URL` = a Healthchecks.io check's ping URL
  (`https://hc-ping.com/<uuid>`; check period 5 min, grace 10 min). Every run pings it — plainly when all is up,
  `/fail` with the down list when not — and Healthchecks emails on each change, and when the pings stop (the Worker
  itself dead). Anything other than an hc-ping.com URL is ignored.
- **Secrets** live only on Cloudflare: dashboard → Workers & Pages → `home-uptime` → Settings → Variables and
  Secrets (or `cf workers secrets update`). Secrets added there survive later deploys (tested).
- **Test alert:** put any value under the KV key `test-alert` (`cf kv keys put test-alert --namespace-id
  79a73c9095ed43d98ec3d51b3a793b51 --body yes`); the next run sends one test alert and deletes the key once it is
  delivered (a refused one is retried every run).
- **Logs:** Workers Logs is on (3 days): each run's `up`/`DOWN` lines and every alert's channel and result —
  dashboard → `home-uptime` → Logs, or `cf observability telemetry query`.
- **Deploy:** `cd worker && npm install && npm test && npm run typecheck && npx cf deploy` (the `cf` CLI,
  OAuth-logged in on the PC). Free-plan budget: one KV write per run = 288 a day (limit 1,000).
- **Adding a target:** one line in `targets.txt` (name, URL, text), then deploy the Worker (the list is inlined).
  Prefer the app's own health route (its Dockerfile `HEALTHCHECK`); check the answer with a plain GET first.

## The GitHub workflow

Scheduled every 10 minutes (GitHub runs it far less often):

- checks the fixed targets (`targets.txt`) and every live listing (status 200 **and** the expected text on
  the page), all at once, retrying 3 times, 20 s apart, before calling anything down;
- logs the home IP that `zeezey.duckdns.org` resolved to. When it doesn't resolve, the listings can't be
  reached past Bot Fight Mode, so they are **unknown**, not down (they used to be fetched through Cloudflare,
  get challenged, and all look down). A target Cloudflare challenges (`403` + `cf-mitigated: challenge` —
  tucsonexperts.com itself, from GitHub) is unknown too. An unknown target keeps its last state: no alert either way;
- sends a phone alert (ntfy) when something **goes down**, again **hourly** while
  it stays down, and once when it **comes back**;
- keeps the current down-list in `status.txt` (committed only on a change).

The alert address is the repo secret `ALERT_WEBHOOK`; it is never in the code.
To prove delivery: Actions → uptime → Run workflow → tick *Send a test alert*.

**Listings need no upkeep.** Each run asks the listing server which listings
are live (`/__sites`): publishing one adds it, retiring one removes it. The last
list seen is kept in `sites.txt`, so if the house is down the monitor still checks
-- and alerts on -- what was live. `targets.txt` holds only fixed things (the launcher, the products).

Tests: `bash test/check.test.sh` runs `check.sh` against a fake `curl` and `getent` (`test/fake-bin/`) and the
workflow's state merge — no network.

## Why the listing sites are checked at the house, not through Cloudflare

tucsonexperts.com has Cloudflare **Bot Fight Mode** on, which challenges every
datacenter (GitHub's included) and cannot be exempted on the free plan. So
`*.tucsonexperts.com` targets are fetched directly from the home IP that
`zeezey.duckdns.org` follows, with their real hostname, and TLS is verified
against Cloudflare's Origin CA root (`cf-origin-ca.pem`, valid to 2029-08-15 --
refresh it from developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem
before then). That catches exactly what this is for: the house or server down.
