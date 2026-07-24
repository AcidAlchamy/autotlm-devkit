# Query API

Every read endpoint the kit serves, with a real request and a real response
for each.

The code behind this page is [`src/api.js`](../src/api.js) (the routes) and
[`src/store.js`](../src/store.js) (the shapes they serve). The responses
below are derived from the canonical Core frame the smoke test ingests —
run `npm test` and you're exercising exactly these.

Two things that are true of the whole query side:

- **No auth.** It's your laptop. (Which is also why you don't expose this
  port — `/api/meta` even hands back the ingest token. See
  [honest limits](../README.md#honest-limits-aka-your-upgrade-path).)
- **Same shapes as AutoTLM Cloud.** Deliberately — see
  [Graduating](graduating.md).

## GET /api/devices

Every device that has ever pushed a frame, most recently seen first.

```
curl -s http://127.0.0.1:3000/api/devices
```

```json
{
  "devices": [
    {
      "id": "A6445000",
      "name": "A6445000",
      "created_at": "2026-07-24T17:03:12.481Z",
      "last_seen": "2026-07-24T17:41:58.112Z",
      "vin": "YV0EXAMPLE0000000"
    }
  ]
}
```

`name` defaults to the id (the kit has no rename UI — that's a Cloud thing).
`vin` is `null` until a frame carries `obd.vin`. No devices yet → `{"devices":[]}`,
never an error.

## GET /api/devices/:id/latest

The last frame the device pushed, verbatim, with the capture time the kit
stamped it.

```
curl -s http://127.0.0.1:3000/api/devices/A6445000/latest
```

```json
{
  "device_id": "A6445000",
  "name": "A6445000",
  "ts": "2026-07-24T17:41:58.112Z",
  "frame": {
    "source": "device",
    "device": { "id": "A6445000", "type": "one", "mems": "MPU-6050", "fw_gnss": "OK", "rssi": -51, "modules": 2 },
    "obd": {
      "connected": true, "speed_kph": 58, "rpm": 1840, "coolant_c": 88,
      "load_pct": 23, "throttle_pct": 14, "volts": 14.2,
      "vin": "YV0EXAMPLE0000000",
      "pids": { "04": 23, "05": 88, "0C": 1840, "0D": 58, "11": 14 }
    },
    "dtc": { "mil": true, "codes": ["P0171"] },
    "gps": {
      "fix": true, "lat": 36.114647, "lng": -115.172813, "alt_m": 610.0,
      "speed_kph": 57.9, "course": 271, "sats": 12, "hdop": 0.8
    },
    "imu": { "ax": 0.02, "ay": -0.11, "az": 1.0, "gx": 0.4, "gy": -0.2, "gz": 0.1 }
  }
}
```

"Latest" means **last arrived**, not newest capture time — a backdated
catch-up frame that arrives after a live one *is* the latest push, and that's
what you get.

This is the one query endpoint that 404s:

```
curl -s http://127.0.0.1:3000/api/devices/NOSUCHDEVICE/latest
```

```json
{ "error": "no_frames" }
```

## GET /api/devices/:id/history

A time range of frames, downsampled to one point per `interval` seconds.

Query parameters, all optional:

| Param | Default | Meaning |
|---|---|---|
| `from` | one hour ago | Range start, ISO 8601 |
| `to` | now | Range end, ISO 8601 |
| `interval` | `5` | Bucket width in seconds (minimum 1; non-numeric falls back to 5) |

```
curl -s "http://127.0.0.1:3000/api/devices/A6445000/history?from=2026-07-24T17:00:00Z&to=2026-07-24T18:00:00Z&interval=60"
```

```json
{
  "device_id": "A6445000",
  "from": "2026-07-24T17:00:00.000Z",
  "to": "2026-07-24T18:00:00.000Z",
  "interval_s": 60,
  "points": [
    { "ts": "2026-07-24T17:40:03.917Z", "frame": { "…": "the full frame, verbatim" } },
    { "ts": "2026-07-24T17:41:58.112Z", "frame": { "…": "one per bucket, oldest first" } }
  ]
}
```

Each point's `frame` is the complete frame object, exactly as in `/latest` —
elided here for space only.

How the downsampling works: each frame falls into a bucket by its capture
time (`floor(ts_ms / interval_ms)`), and the frame with the **newest capture
time wins the bucket** — so a late catch-up upload can never overwrite a
fresher live point (see [the age_ms story](ingest.md#the-age_ms-story)).
Points come back oldest-first, capped at 5000 (the newest survive).

**404 semantics, deliberately:** an unknown device — or a range with nothing
in it — returns the normal shape with `"points": []`, not an error. Chart
code just renders zero points; you never branch on status for history.

## GET /api/devices/:id/dtc

The trouble-code ledger: every code the device has ever reported, with
first/last seen and whether it's currently active.

```
curl -s http://127.0.0.1:3000/api/devices/A6445000/dtc
```

```json
{
  "device_id": "A6445000",
  "mil": true,
  "codes": [
    {
      "code": "P0171",
      "first_seen": "2026-07-24T17:03:12.481Z",
      "last_seen": "2026-07-24T17:41:58.112Z",
      "active": true
    }
  ]
}
```

Active codes sort first. A code goes `"active": false` when a frame carrying
a `dtc` object no longer lists it — a dtc-carrying frame is authoritative
about what's stored in the car, so missing means cleared. It stays on the
ledger, because "it threw P0300 last winter" is exactly what you want to know
in a diagnostics view.

Same no-404 rule as history: an unknown device gets
`{"device_id":"…","mil":false,"codes":[]}`.

## GET /api/devices/:id/live

Server-Sent Events — one message per ingested frame. Big enough to be its own
page: [Live streaming (SSE)](sse.md).

## GET /healthz

```
curl -s http://127.0.0.1:3000/healthz
```

```json
{ "ok": true, "devices": 1, "frames_received": 42 }
```

Liveness plus the two counters. `frames_received` counts accepted frames this
process (after a persistence replay it resets to the replayed count — see
[Storage](storage.md#rung-2-jsonl-persistence)).

## GET /api/meta

What the console's start screen shows you: who this kit is and how to
provision a device at it.

```
curl -s http://127.0.0.1:3000/api/meta
```

```json
{
  "product": "AutoTLM",
  "kit": "DevKit",
  "version": "0.4.0",
  "port": 3000,
  "ingest_urls": [
    "http://127.0.0.1:3000/api/ingest",
    "http://192.168.1.23:3000/api/ingest"
  ],
  "devices": 1,
  "frames_received": 42
}
```

`ingest_urls` lists every address a device on your network could reach the
kit at — the LAN one (yours will differ from the example) is the one to
provision a real device with.

**The caveat, again:** the real response also includes a `"token"` field —
the actual ingest token, in plaintext. That's a convenience for *your*
console on *your* machine, and one more reason this port never gets exposed
as-is. We've elided it above precisely because it's the one field you
shouldn't be pasting anywhere.

## Related pages

- [Ingest](ingest.md) — the write side
- [Live streaming (SSE)](sse.md) — `/live`, in full
- [Consuming frames](frame-consuming.md) — walking the `frame` objects safely
- The [CSV kit](../kits/csv/README.md) — `/history` as a spreadsheet, done for you

[← back to the index](README.md)
