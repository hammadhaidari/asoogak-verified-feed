# AsooGak Verified Feed (alive-only bridge)

The catalogue scanner (`asoogak-catalogue-scanner`) grows the library: it discovers titles and deep-verifies them
(resolver, manifest, real video bytes). This repo is the **bridge between that list and the TV**:

- Every 30 min it reads the scanner's list and re-proves **every listed title with one cheap request** (two for a series:
  first + latest playable season). Every dead title observed so far dies at exactly this step ("no stream").
- Popular titles (top ~3,000) are re-proven every 4h, the rest daily. Least-recently-proven titles always go first.
- It publishes `feed-data/catalogue.json`: the scanner's list **minus** whatever it has proven dead. It can only remove
  titles, never add ones the scanner did not list. A dead verdict hides a title for 72h unless the scanner deep-verifies it again.
- The TV reads this feed first and **falls back to the scanner's list** if the feed is missing, older than 4h, or implausibly small.
- Safety valve: a run that would suddenly hide more than 8% of the library is treated as a provider/network incident
  and its dead verdicts are discarded.

## Runner budget
GitHub allows ~20 concurrent jobs **per account**, shared by both repos. Defaults: scanner 10 shards (`SCANNER_SHARDS`),
this repo 10 (`SHARDS`). Adjust either with repository variables; keep the sum <= 20. Putting this repo in a separate free
GitHub organization gives it its own 20 slots and fresh IPs.

Secrets: `RESOLVER_KEY` (required), `PROXY_URL` (optional fallback egress). Tests: `npm test`.
