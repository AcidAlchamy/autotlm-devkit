# Storage

Where frames live: the in-memory ring buffer, the JSONL flight recorder, the
SQLite kit — and the Postgres upgrade you'll eventually write yourself.

The DevKit treats storage as a ladder. Each rung is a real, working
implementation you can read end to end, and each one exists to teach the
next: RAM shows you the shapes, JSONL shows you durability at its crudest,
SQLite shows you what a real database buys, and Postgres is the exercise left
for you. The rest of the kit only ever talks to the storage layer's function
surface — `addFrame`, `listDevices`, `latest`, `history`, `dtcReport`,
`stats` — which is exactly what makes the rungs swappable.

## Rung 1: the in-memory ring buffer

The core kit's store ([`src/store.js`](../src/store.js)) is a `Map` of
devices, each holding a **ring buffer** of `{ ts, frame }` pairs: append on
ingest, and once the buffer passes `DEVKIT_BUFFER` frames (default 5000),
the oldest falls off the front. Alongside the frames, a little bookkeeping —
`last_seen`, VIN, MIL, and the per-code DTC ledger — is updated as frames
land, so the query API never scans the buffer to answer.

**Why it's like this:** zero dependencies, instant boot, and the entire
storage layer is readable in one file. A starter should cost you nothing to
run and nothing to understand.

**The limits, honestly:**

- **Restart = clean slate.** RAM is RAM.
- **The cap is per device.** At one frame per 2 s, 5000 frames is roughly
  2¾ hours of drive per device — older points silently leave `/history`.
- **It's per process.** Two kit processes are two separate worlds.

## Rung 2: JSONL persistence

Set `DEVKIT_PERSIST=1` and the core kit appends every accepted frame to a
JSON-lines file (`DEVKIT_PERSIST_FILE`, default `data/telemetry.jsonl`) —
one object per line, exactly what the store holds:

```
{"ts":"2026-07-24T17:41:58.112Z","frame":{...}}
```

On next boot the kit replays the file through the normal `addFrame` path (so
ring caps and the DTC ledger square up as if the frames had just arrived),
resets `frames_received` to the replayed count rather than double-counting,
then reopens the file for appending.

**Torn lines:** a crash mid-write can leave a half-line at the end of the
file. Replay parses line by line and *skips* anything that doesn't parse —
a torn tail costs you that one frame, never the boot.

**What this is and isn't:** it's a flight recorder — an append-only log that
makes restarts survivable and doubles as raw material for the
[replay kit](../kits/replay/README.md) (which re-POSTs a recording of your
real gear at its original cadence). It is *not* a database: it grows forever,
answers no queries, and replay time grows with it. When the file stops being
funny, you're ready for the next rung.

## Rung 3: the SQLite kit

[`kits/sqlite`](../kits/sqlite/README.md) is the core kit with the storage
layer genuinely replaced: same HTTP surface, same console, but frames land in
a SQLite file via `node:sqlite` — the driver that ships inside Node itself
(≥ 22.5; it prints an honest `ExperimentalWarning` at boot), so the repo
still depends on express and nothing else.

```
node kits/sqlite/server.js
```

The whole swap lives in [`kits/sqlite/src/db.js`](../kits/sqlite/src/db.js).

### The schema, and why each piece exists

```
devices                           frames                          dtc
──────────────────────            ──────────────────────          ──────────────────────
id          TEXT  PK      ┌────<  device_id   TEXT        ┌────<  device_id   TEXT  ┐PK
name        TEXT          │       ts          TEXT        │       code        TEXT  ┘
vin         TEXT          │       frame_json  TEXT        │       first_seen  TEXT
created_at  TEXT          │                               │       last_seen   TEXT
last_seen   TEXT          │       INDEX (device_id, ts)   │       active      INTEGER
mil         INTEGER       ┘                               ┘
```

One table per concern the query API serves:

- **`devices`** — the roster. One row per device id carrying exactly what
  `GET /api/devices` returns, so listing devices never touches the frames
  table. `last_seen` is updated with a guarded
  `UPDATE … WHERE last_seen < ?` — only ever forward, so a backdated
  catch-up frame can't roll a device into the past.
- **`frames`** — every accepted frame, **verbatim JSON**, at its capture
  time. The frame stays an opaque document on purpose: the contract belongs
  to Core, and a store that exploded it into columns would need a migration
  every time the contract grew. The `(device_id, ts)` index is the one that
  matters — every history query is "this device, this time range", which is
  precisely a range scan on that index. Timestamps are ISO-8601 UTC strings,
  which sort like the times they name, so string comparison *is* time
  comparison.
- **`dtc`** — the trouble-code ledger, `PRIMARY KEY (device_id, code)`.
  Upserted on ingest (`ON CONFLICT … DO UPDATE`), and cleared the same way
  the core kit does: a frame carrying a `dtc` object is authoritative, so
  codes it doesn't list get `active = 0`.

Booleans are stored as 0/1 (SQLite has no boolean type) and converted back to
real `true`/`false` at the API edge — the response shapes are the contract.

### WAL mode

The kit opens the database with `PRAGMA journal_mode = WAL` and
`synchronous = NORMAL`. WAL (write-ahead logging) means readers never block
the writer — the console can poll history while frames stream in — and a
crash mid-write tears one transaction, never the file. `NORMAL` is the
standard WAL pairing: durable to the last checkpoint, fast enough for a live
telemetry stream. Each ingested frame is one transaction — roster, frame and
ledger move together or not at all.

### How bucketing works in SQL

The core kit downsamples history in a JS loop; the SQLite kit pushes the same
arithmetic into the database:

```sql
SELECT MAX(ts) AS ts, frame_json
FROM (
  SELECT ts, frame_json,
         CAST(unixepoch(ts, 'subsec') * 1000 AS INTEGER) / :interval_ms AS bucket
  FROM frames
  WHERE device_id = :id AND ts >= :from AND ts <= :to
)
GROUP BY bucket
ORDER BY bucket DESC
LIMIT :cap
```

Reading it inside out: `unixepoch(ts, 'subsec')` converts the ISO timestamp
to epoch seconds *with* the milliseconds (matching JS `Date.parse` exactly),
`* 1000 / interval_ms` integer-divides capture time into a bucket index —
the same `floor(ts_ms / step)` the core kit computes. The outer `GROUP BY`
keeps one row per bucket, and here's the SQLite idiom doing the real work:
with a **lone `MAX()` aggregate, SQLite serves the ungrouped columns from the
row that won the max** — so each bucket's row is the frame with the newest
capture time. That's the newest-capture-wins rule from
[the age_ms story](ingest.md#the-age_ms-story), enforced by the query shape
itself. `DESC + LIMIT` keeps the newest `cap` buckets; the kit re-sorts
ascending in JS before serving.

(A trade-off worth naming: this is the cleverest SQL in the repo. If it ever
stops being readable to you, doing the bucketing in JS after a ranged SELECT
is a legitimate answer — same result, more rows over the wire, and
readability wins arguments like that.)

### The ring buffer's durable cousin

`DEVKIT_BUFFER` (default 50,000 here — disk is cheap where RAM wasn't) caps
frames per device. Rather than deleting on every insert, the kit trims each
device every 100 inserts — a `DELETE` of everything past the newest
`DEVKIT_BUFFER` rows — so counts can briefly overshoot by up to 99. A sweep
at boot squares everything up, which is also what makes *lowering* the cap
take effect immediately.

### Inspect it yourself

The database is a normal SQLite file (default
`kits/sqlite/data/telemetry.db`) — every SQLite tool works on it:

```
sqlite3 kits/sqlite/data/telemetry.db
sqlite> .tables
devices  dtc  frames
sqlite> SELECT id, last_seen, vin FROM devices;
sqlite> SELECT COUNT(*), MIN(ts), MAX(ts) FROM frames WHERE device_id = 'A6445000';
sqlite> SELECT json_extract(frame_json, '$.obd.rpm') AS rpm, ts
   ...> FROM frames WHERE device_id = 'A6445000' ORDER BY ts DESC LIMIT 5;
```

No `sqlite3` CLI on your machine? [DB Browser for SQLite](https://sqlitebrowser.org/)
opens the same file with a GUI. Prefer to stop the kit first (or accept
read-only) — WAL tolerates concurrent readers, but two *writers* is the one
thing single-file SQLite won't referee.

## Rung 4: the Postgres exercise

There is deliberately no `kits/postgres`. By the time you need one, you'll
have read the SQLite kit — and writing the next rung yourself is the point of
the ladder. What actually changes, as guidance rather than code:

- **The driver goes async.** `node:sqlite`'s `DatabaseSync` is synchronous;
  a Postgres client gives you promises and a connection pool. The storage
  functions become `async`, and the API routes `await` them — a mechanical
  change, but it touches every call site.
- **The schema translates almost verbatim.** `TEXT` timestamps become
  `TIMESTAMPTZ`, `frame_json` becomes `JSONB` (indexable, queryable —
  `frame_json->'obd'->>'rpm'` replaces `json_extract`), booleans become real
  `BOOLEAN`, and the `(device_id, ts)` index carries over unchanged.
- **Bucketing gets a native function.** The `unixepoch`-divide trick becomes
  `date_bin(interval, ts, origin)` (Postgres 14+); `DISTINCT ON` or a window
  function replaces the lone-aggregate idiom for newest-capture-wins —
  Postgres, unlike SQLite, won't let a bare column ride an aggregate.
- **You inherit real concurrency.** Multiple kit processes can share one
  database — which is the actual reason to graduate rungs: SQLite's single
  writer was never a problem until you wanted two.
- **You'll want migrations.** SQLite's `CREATE TABLE IF NOT EXISTS` on boot
  stops being enough once the schema evolves under data you care about.
  That's not a library recommendation — even a numbered folder of `.sql`
  files beats nothing.

And when even that stops being fun: [graduating to AutoTLM Cloud](graduating.md)
is the rung where the storage stops being your problem at all.

## Related pages

- [Ingest](ingest.md) — how frames arrive and get their capture time
- [Query API](query-api.md) — the shapes every rung must serve
- The [SQLite kit README](../kits/sqlite/README.md) — quickstart and honest limits
- The [replay kit README](../kits/replay/README.md) — your JSONL recordings, replayed

[← back to the index](README.md)
