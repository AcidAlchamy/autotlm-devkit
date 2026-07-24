# Ingest

Everything about `POST /api/ingest` — the one endpoint your device talks to.

The code behind this page is [`src/api.js`](../src/api.js) (the route) and
[`src/store.js`](../src/store.js) (what happens to an accepted frame). Both
are short; read them alongside this.

## The endpoint

```
POST /api/ingest
Authorization: Bearer <token>
Content-Type: application/json
```

The body is **one frame object, or an array of up to 50 frames** (a device
catching up after a connectivity gap batches them — see
[the age_ms story](#the-age_ms-story) below). The frame format itself belongs
to AutoTLM Core — see [Consuming frames](frame-consuming.md).

A successful POST answers:

```json
{ "ok": true, "accepted": 1 }
```

`accepted` counts the frames that made it into the store. Entries in a batch
that aren't JSON objects are skipped, not fatal — the valid ones still land.

### A frame by hand

The same check-the-plumbing example the main README uses (with the default
token; the startup banner prints yours):

```
curl -s -X POST http://127.0.0.1:3000/api/ingest \
  -H "Authorization: Bearer devkit" -H "Content-Type: application/json" \
  -d '{"source":"device","device":{"id":"MYCAR"},"obd":{"connected":true,"rpm":1840,"speed_kph":58,"coolant_c":88}}'
```

### A batch, with ages

Three frames from one offline gap — captured 10 s ago, 5 s ago, and just now.
Oldest first, strictly decreasing age, exactly as Core batches them:

```
curl -s -X POST http://127.0.0.1:3000/api/ingest \
  -H "Authorization: Bearer devkit" -H "Content-Type: application/json" \
  -d '[{"device":{"id":"MYCAR"},"obd":{"rpm":2100},"age_ms":10000},
       {"device":{"id":"MYCAR"},"obd":{"rpm":1950},"age_ms":5000},
       {"device":{"id":"MYCAR"},"obd":{"rpm":1840}}]'
```

Then look at `/history?interval=1` for MYCAR: three points, spread across ten
seconds — not one clump stamped "now". That spread is the whole point of the
next section.

## Auth

The route wants exactly `Authorization: Bearer <token>`, compared as a plain
string against `DEVKIT_TOKEN` (default `devkit`). Anything else — missing
header, wrong token, `bearer` games — is a `401`:

```json
{ "error": "unauthorized" }
```

The default token is a local-dev convenience. Override it the moment the kit
is reachable by anyone but you (`DEVKIT_TOKEN=something-long-and-random
npm start`), and read the ["honest limits"](../README.md#honest-limits-aka-your-upgrade-path)
section before exposing the port at all — the query side has no auth.

## Limits

| Limit | Value | What you see when you hit it |
|---|---|---|
| Body size | 256 KB | HTTP `413` from the JSON parser |
| Frames per batch | 50 | `400` `{"error":"too_many_frames"}` |
| No valid frames in the body | — | `400` `{"error":"no_valid_frames"}` |
| `age_ms` | ≤ 7 days | Larger (or negative, or non-numeric) values are treated as absent |

The 256 KB body cap matches the device-side contract — a batch of 50 real
frames fits with room to spare.

## The age_ms story

Devices in cars lose connectivity — parking garages, dead zones, ignition
cycles. When a device comes back online it uploads what it buffered as a
batch, and here's the problem: **it has no wall clock we trust**. What it
*does* know, reliably, is how long ago it captured each frame. So each
buffered frame carries a top-level `age_ms` — a relative age in milliseconds —
and live frames simply omit the field.

The kit turns that relative age into an absolute capture time on arrival:

```
ts = receivedAt − age_ms
```

So a drive through a connectivity gap lands as a correctly-spread timeline
instead of one clump at upload time. This is the same rule the production
cloud applies — build against it here and nothing changes later.

Two guards keep it honest:

- **The 7-day rule.** An `age_ms` over 7 days (or negative, or not a number)
  is treated as absent and the frame is stamped at arrival. A corrupt value
  must never backdate history into the far past.
- **Newest capture wins.** Backdated frames can arrive *after* fresher live
  ones. A device's `last_seen` only moves forward, and in
  [history downsampling](query-api.md#get-apidevicesidhistory) the newest
  *capture* time wins each bucket — so a late catch-up upload can never
  overwrite a fresher live point.

The smoke test walks this exact scenario
([`test/smoke.test.js`](../test/smoke.test.js), "batched catch-up frames
spread across history via age_ms") — it doubles as executable documentation.

One consumer-side note: the [SSE live channel](sse.md) broadcasts catch-up
frames as they're ingested, with the backdated `ts`. The
[console](console.md) shows a `CATCH-UP` tag when that happens, and the
[alerts kit](../kits/alerts/README.md) clocks its rules on `ts`, not arrival —
follow the same pattern in your own consumers.

## Common mistakes

- **Wrong token** → `401 {"error":"unauthorized"}`. Check the startup banner —
  it prints the token the kit actually expects.
- **Missing `Content-Type: application/json`** — the sneakiest one. The JSON
  parser skips a body whose type it doesn't recognize and leaves an *empty*
  body object behind, so the route happily accepts an empty frame: you get
  `{"ok":true,"accepted":1}`, but nothing you sent was stored, and the empty
  frame lands in the `UNKNOWN` device. If the console shows `UNKNOWN`
  filling with blank frames, check your header first.
- **Sending the frame as a quoted JSON string** (`-d '"{...}"'`, or
  double-serializing in code) → the parser is strict and accepts only a
  top-level object or array: HTTP `400` before the route ever runs.
- **Malformed JSON** → same: the parser rejects the request with a `400`
  (an HTML error page from the parser, not a JSON body) before the route
  runs.
- **An empty array, or a batch of non-objects** → the route runs, finds
  nothing storable, and answers `400 {"error":"no_valid_frames"}`.
- **Batching 51+ frames** → `400 {"error":"too_many_frames"}`. Split the
  batch; Core never sends more than 50.
- **No `device.id` in the frame** → not an error, but every such frame merges
  into one shared `UNKNOWN` device. Set an id early. (See
  [Consuming frames](frame-consuming.md#5-the-unknown-device).)

## Related pages

- [Query API](query-api.md) — reading back what you ingested
- [Storage](storage.md) — where accepted frames actually go
- [Consuming frames](frame-consuming.md) — the frame contract's rules

[← back to the index](README.md)
