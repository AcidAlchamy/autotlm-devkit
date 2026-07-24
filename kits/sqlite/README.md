# SQLite kit — the first upgrade, done for you

**The core kit with a real database under it.** Same API, same console, same
frame contract — but stop the server and start it again, and your history is
still there.

## Why a database

The [core kit](../../README.md) stores frames in an in-memory ring buffer, and
its own README is honest about what that means: restart = clean slate, and the
optional JSON-lines flag is a log, not a database. It also names the first real
upgrade — SQLite. This kit **is** that upgrade, kept as readable as the thing
it upgrades, so you can see exactly what "swap the storage layer" means before
you do it yourself with Postgres. The full storage story — ring buffer vs
JSONL vs SQLite, and when each is enough — lives in
[docs/storage.md](../../docs/storage.md).

## Quickstart

From the repo root (the kit leans on the root's `public/` console and
`src/config.js`, so it runs from the monorepo clone):

```
npm install
node kits/sqlite/server.js       →  console on http://localhost:3801
```

Node **22.5 or newer** required — the database is `node:sqlite`, built into
Node itself, so there is still nothing to install beyond express. You'll see
an `ExperimentalWarning` about SQLite at boot; that's Node being upfront about
the module's status, not a problem with your setup. Everything else works
exactly like the core kit: point your AutoTLM One (or the Car-Emulator on
your bench) at the ingest URL from the startup banner, and the console fills
in live.

Prove the durability claim to yourself in ten seconds: ingest a frame (the
core README's curl one-liner works verbatim — just change the port to 3801),
Ctrl-C the server, start it again, and `GET /api/devices/MYCAR/latest` still
answers.

## How it works

One file changed hands. The core kit's `src/store.js` (the ring buffer) is
replaced by [`src/db.js`](src/db.js) — same function surface, backed by a
SQLite file in WAL mode. Everything else in [`server.js`](server.js) mirrors
the core kit's `src/api.js` route for route: same auth, same batch-of-50
limit, same `age_ms` capture-time rule, same SSE live channel, same response
shapes. That's the point — the HTTP surface is the contract, storage is an
implementation detail, and anything you built against the core kit (or the
console itself, which this kit serves unmodified from the root `public/`)
cannot tell the difference.

### The schema

```
devices                    frames                      dtc
┌────────────────┐         ┌──────────────────┐        ┌──────────────────┐
│ id         PK  │ 1     * │ device_id        │        │ device_id  ┐     │
│ name           │ ─────── │ ts               │        │ code       ┘ PK  │
│ vin            │         │ frame_json       │        │ first_seen       │
│ created_at     │         └──────────────────┘        │ last_seen        │
│ last_seen      │          index (device_id, ts)      │ active           │
│ mil            │                                     └──────────────────┘
└────────────────┘
```

- **`devices`** is the roster — everything `GET /api/devices` serves, one row
  per device id, `last_seen` only ever moving forward.
- **`frames`** is the telemetry itself: every accepted frame stored verbatim
  as JSON at its capture time. The `(device_id, ts)` index is what makes
  `/history` range queries cheap; the downsampling (one point per interval,
  newest capture wins the bucket) happens in SQL — open `src/db.js` and read
  the `history` statement, it's commented line by line.
- **`dtc`** is the trouble-code ledger — first-seen / last-seen / active per
  code per device, updated with the same "a frame carrying `dtc` is
  authoritative" rule the core kit applies.

The ring buffer's durable cousin: after every hundred inserts per device, the
oldest frames beyond `DEVKIT_BUFFER` are deleted — so the file stays bounded,
it just bounds at 50,000 frames per device instead of 5,000, because disk is
cheap where RAM wasn't.

## Configuration

Everything is an env var with a dev-friendly default:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3801` | HTTP port for everything (out of the core kit's way — run both at once) |
| `DEVKIT_TOKEN` | `devkit` | Bearer token required on `/api/ingest` |
| `DEVKIT_BUFFER` | `50000` | Frames kept **on disk** per device (oldest deleted in batches) |
| `DEVKIT_DB` | `kits/sqlite/data/telemetry.db` | The database file (dir auto-created; `data/` is gitignored) |

Container-minded? The [Dockerfile](Dockerfile) builds the same thing — build
from the **repo root** (`docker build -f kits/sqlite/Dockerfile .`) since the
kit needs the root's `public/` and `src/`, and mount a volume over
`/app/kits/sqlite/data` so the database outlives the container too.

## Inspect it yourself

The database is a normal SQLite file — every tool in the ecosystem opens it.
That's half the fun of graduating from a ring buffer: your telemetry becomes
something you can *query*.

With the [`sqlite3` CLI](https://sqlite.org/cli.html):

```
sqlite3 kits/sqlite/data/telemetry.db
sqlite> SELECT id, vin, last_seen FROM devices;
sqlite> SELECT COUNT(*) FROM frames WHERE device_id = 'MYCAR';
sqlite> SELECT ts, json_extract(frame_json, '$.obd.rpm') FROM frames
   ...> WHERE device_id = 'MYCAR' ORDER BY ts DESC LIMIT 10;
```

Prefer a GUI? [DB Browser for SQLite](https://sqlitebrowser.org/) opens the
file directly — browse the tables, run the same queries. (If the server is
running, WAL mode means read-only inspection alongside it is fine; just don't
have two *writers*.)

## Testing

```
node --test kits/sqlite/test/sqlite.test.js
```

walks the same loop as the core kit's smoke test, then the reason this kit
exists: kill the server, boot a fresh process on the same file, and assert
the history is still served. The repo-root `npm test` runs it too.

## Honest limits (a.k.a. your next upgrade)

- **Single writer.** SQLite in WAL mode handles one writing process happily —
  it is exactly the wrong tool the moment you want two server instances on a
  shared database. That's the Postgres line, and the kit doesn't pretend
  otherwise.
- **No migrations.** The schema is created with `CREATE TABLE IF NOT EXISTS`
  and never altered. If you change the schema in `src/db.js`, delete the
  database file (or `ALTER TABLE` by hand) — a real app wants a migration
  tool.
- **The `ExperimentalWarning` is real.** `node:sqlite` is marked experimental
  and its API could shift between Node versions. The surface this kit uses
  (open, prepare, run, get, all) is small and steady, but pin your Node
  version if that worries you.
- **Same security posture as the core kit** — unauthenticated query
  endpoints, plain string token compare, no rate limiting. Storage got
  durable; nothing got production-hardened. The core README's
  [honest limits](../../README.md#honest-limits-aka-your-upgrade-path) all
  still apply.
- **Your next upgrade: Postgres.** Same exercise this kit performed on the
  core: keep the function surface of `src/db.js`, swap what's behind it —
  a connection pool, real types instead of JSON-in-a-column where it earns
  its keep, and multiple writers for free.
  [docs/storage.md](../../docs/storage.md) sketches the path.

---

← back to the [DevKit README](../../README.md)
