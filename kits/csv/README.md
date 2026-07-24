# kits/csv — history → spreadsheet

**One command turns a device's `/history` into a CSV you can open in Excel,
Sheets or pandas — or a JSONL file that keeps every frame verbatim.**

The [DevKit](../../README.md) stores whatever your gear pushes and serves it
back over a clean query API. This kit is the smallest useful consumer of that
API: a zero-dependency exporter that fetches `/history` for one device,
flattens each frame into rows and columns, and writes it out. No install step
beyond the repo's own `npm install` — the exporter itself is bare Node.

## Quickstart

From the repo root, with a kit running and a device pushing (or having
pushed):

```
node kits/csv/export.js --device MYCAR > drive.csv
```

Output goes to **stdout** by default, so it pipes anywhere; `--out` writes a
file instead. Status chatter goes to stderr, so your pipe stays clean.

```
node kits/csv/export.js --device MYCAR --from 2026-07-24T18:00:00Z --to 2026-07-24T19:00:00Z --interval 1 --out drive.csv
node kits/csv/export.js --device MYCAR --format jsonl --out drive.jsonl
node kits/csv/export.js --base https://your-cloud-host --device MYCAR
```

Run it without `--device` and it lists the devices the kit knows, so you
never have to remember an id.

## How the columns are built

Each `/history` point is `{ts, frame}`. The exporter walks the frame and
emits one column per **scalar** it finds, with a group prefix so nothing
collides (`obd` and `gps` both carry a `speed_kph`):

| Column(s) | Source in the frame |
|---|---|
| `ts` | the point's capture time (ISO — the kit's age_ms rule already applied) |
| `device_id` | the device you exported |
| `obd_*` | every scalar under `obd` except `pids` (`obd_rpm`, `obd_coolant_c`, `obd_vin`, …) |
| `gps_*` | every scalar under `gps` (`gps_lat`, `gps_sats`, `gps_source`, …) |
| `imu_*` | every scalar under `imu` (`imu_ax` … `imu_gz`) |
| `dtc_mil` | `dtc.mil` |
| `pid_XX` | one column per key in `obd.pids` (`pid_04`, `pid_0C`, …) |

Two rules make the output dependable:

- **The header is the union across all points.** Every sub-object in the
  frame is optional, and fields inside them come and go — a PID that showed
  up for one frame mid-drive still gets its column; every other row gets an
  empty cell there. Nothing is silently dropped for being intermittent.
- **Column order is deterministic**: the fixed `ts, device_id` pair, then
  `obd_*`, `gps_*`, `imu_*`, `dtc_mil`, `pid_*` — sorted within each group.
  Same data, same header, every time, so downstream scripts can rely on it.

Quoting is RFC-4180: fields containing a comma, a double quote or a line
break are wrapped in double quotes with embedded quotes doubled; everything
else stays bare so spreadsheets parse numbers as numbers. Lines end in LF.

## JSONL mode

`--format jsonl` skips the flattening entirely: one `{ts, frame}` object per
line, the frame **verbatim** — arrays and nested objects (`dtc.codes`,
`dtc.freeze`, `obd.supported`) included, which CSV cells can't hold. It's
the same line format the kit's own `DEVKIT_PERSIST` flag writes, so anything
built against that file — [kits/replay](../replay/README.md) included — can
read an export too. (Mind that `/history` is downsampled; see the limits
below.)

## Open it

- **Excel** — File → Open the `.csv` (or just double-click it).
- **Google Sheets** — File → Import → Upload.
- **pandas** — `pd.read_csv("drive.csv", parse_dates=["ts"])`, or for JSONL
  `pd.read_json("drive.jsonl", lines=True)`.

## Configuration

No environment variables — everything is a flag:

| Flag | Default | Meaning |
|---|---|---|
| `--base <url>` | `http://127.0.0.1:3000` | The kit (or cloud) to export from |
| `--device <id>` | — (required) | Which device — omit it to get the roster |
| `--from <ISO>` | server default (one hour ago) | Range start |
| `--to <ISO>` | server default (now) | Range end |
| `--interval <s>` | server default (5) | Downsample bucket, seconds |
| `--out <file>` | stdout | Write to a file instead |
| `--format <csv\|jsonl>` | `csv` | Output format |

## Testing

```
node --test kits/csv/test/csv.test.js
```

boots the real kit on a scratch port, ingests three frame variants, runs the
exporter as a child process — the same way you do — and checks the header
union, column values, RFC-4180 quoting and the JSONL round-trip. It's also
picked up by the repo-root `npm test`.

## Honest limits

- **It exports `/history`, and `/history` is downsampled** — newest frame
  per `--interval` bucket, capped server-side at 5,000 points per call. This
  is a chart-friendly view of a drive, not a raw packet log (the kit's
  `DEVKIT_PERSIST` file is the raw log — see
  [docs/storage.md](../../docs/storage.md)).
- **Memory-bound**: the whole export is built in memory before it's written.
  With the history cap that's fine; for long drives, split the range with
  `--from`/`--to` or widen `--interval`.
- **One device per run.** Exporting a fleet is a shell loop away.
- **CSV cells hold scalars.** Arrays and nested objects don't make it into
  CSV — that's what `--format jsonl` is for.

More on the endpoints this kit consumes:
[docs/query-api.md](../../docs/query-api.md) · back to the
[DevKit README](../../README.md).
