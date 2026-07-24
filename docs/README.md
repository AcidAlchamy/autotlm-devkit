# AutoTLM DevKit — documentation

The long-form companion to the [main README](../README.md): one page per thing
you'll actually do with the kit, in the order you'll probably do it.

The kit itself is small enough to read — these pages don't replace the source,
they walk you through it. Every claim here is backed by a file you can open;
when a page and the code ever disagree, the code wins and we'd like to know.

## The pages

| Page | What it covers |
|---|---|
| [Ingest](ingest.md) | `POST /api/ingest` — auth, batching, limits, and the full `age_ms` story |
| [Query API](query-api.md) | Every read endpoint with real request + response examples |
| [Live streaming (SSE)](sse.md) | The `/live` channel — wire format, consuming it from a browser and from Node |
| [Storage](storage.md) | The ring buffer, JSONL persistence, the SQLite kit's schema, and the Postgres exercise |
| [Consuming frames](frame-consuming.md) | The frame contract's consumer rules, and how to walk a frame without crashing |
| [The mini-console](console.md) | How the no-build console works, and where to start ripping it apart |
| [Graduating to Cloud](graduating.md) | What changes, what stays, and what the DevKit deliberately doesn't do |

## How they fit

Data flows **in** through [ingest](ingest.md), lands in [storage](storage.md),
and comes back **out** through the [query API](query-api.md) and the
[SSE live channel](sse.md). Everything that reads a frame — the
[console](console.md), your code — plays by the
[consumer rules](frame-consuming.md). And when the laptop stops being enough,
[graduating](graduating.md) is a base-URL change, not a rewrite.

## The kit family

The repo also ships four sibling kits, each with its own README:

- [`kits/sqlite`](../kits/sqlite/README.md) — the core kit with a real database
  under it. Same API, same console; restarts stop erasing history.
- [`kits/alerts`](../kits/alerts/README.md) — a zero-dependency watcher that
  subscribes to the live channel and fires rules (console, webhook, Discord).
- [`kits/csv`](../kits/csv/README.md) — exports `/history` to CSV or JSONL for
  Excel, Sheets or pandas.
- [`kits/replay`](../kits/replay/README.md) — replays a JSONL recording of your
  own drive at its original cadence. The family ships no fake data; this is
  how you get a repeatable stream anyway.

All of them run from the repo root of the monorepo clone (`node kits/<name>/…`)
and speak the same contract, so every page here applies to them too.
