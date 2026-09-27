# home-uptime

An outside watcher for the sites that run from home: the Listing Launcher and
every listing site at `<slug>.tucsonexperts.com`.

The nightly audit runs on the same home server as the sites, so if the house
loses power or internet, nothing is left to notice. This runs on GitHub's
machines instead, every 10 minutes:

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
