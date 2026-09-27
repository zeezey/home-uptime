# home-uptime

An outside watcher for the sites that run from home: the Listing Launcher and
every listing site at `<slug>.tucsonexperts.com`.

The nightly audit runs on the same home server as the sites, so if the house
loses power or internet, nothing is left to notice. This runs on GitHub's
machines instead, every 10 minutes:

- checks each line of `targets.txt` (status 200 **and** the expected text on
  the page), retrying 3 times, 20 s apart, before calling anything down;
- sends a phone alert (ntfy) when something **goes down**, again **hourly** while
  it stays down, and once when it **comes back**;
- keeps the current down-list in `status.txt` (committed only on a change).

The alert address is the repo secret `ALERT_WEBHOOK`; it is never in the code.
To prove delivery: Actions → uptime → Run workflow → tick *Send a test alert*.

When a listing goes live or closes, add or remove its line in `targets.txt`.
