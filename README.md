# AutoTLM DevKit

**Your car's backend, on your laptop.**

You bought an [AutoTLM One](https://autotlm.com), wrote your first sketch with
[AutoTLM Core](https://github.com/AcidAlchamy/autotlm-core)… and now your
telemetry needs somewhere to *go*. Long before you care about a cloud account,
you want a receiving end you can see into — on your own machine, in under a
minute.

That's this kit: a small, readable **Express backend + live mini-console** —
the receiving stage, already set up. It ingests exactly what AutoTLM Core
pushes, stores it, serves it back over a clean query API, and renders a
cockpit-style console in your browser — live gauges, a raw frame inspector,
and plain-English fault decoding.

It does **not** manufacture data. The only thing that lights it up is real
telemetry from your own gear — an **AutoTLM One** reading a real car, or the
**Car-Emulator** on your bench (driven by **AutoTLM Studio**). That's the
point: a receiving end for what you actually build, not a demo full of fake
numbers.

It is deliberately a **starter, not a product**. Open it up. Rip it apart.
Build your thing on top of it.

```
git clone https://github.com/AcidAlchamy/autotlm-devkit
cd autotlm-devkit
npm install
npm start        →  console on http://localhost:3000
```

The console opens empty, waiting — because the data comes from your device.

## Point your device at it

Your AutoTLM One pushes to whatever cloud URL it was provisioned with. So aim
it here:

1. `npm start` and read the startup banner — it prints the kit's **LAN ingest
   URL** (e.g. `http://192.168.1.23:3000/api/ingest`) and the **token**. The
   console's start screen shows the exact values to copy, too.
2. In the One's setup portal, set that URL + token as the cloud target.
3. Power it on — plugged into a real car, or into the Car-Emulator on your
   bench. Frames land here with **zero code changes**, and the console fills
   in live. The kit speaks the same ingest contract as the production cloud.

**Just checking the plumbing?** You can POST a frame by hand — that's you
feeding it real data on purpose, which is fine:

```
curl -s -X POST http://127.0.0.1:3000/api/ingest \
  -H "Authorization: Bearer devkit" -H "Content-Type: application/json" \
  -d '{"source":"device","device":{"id":"MYCAR"},"obd":{"connected":true,"rpm":1840,"speed_kph":58,"coolant_c":88}}'
```

## The API surface

Ingest (what a device POSTs):

| Endpoint | Notes |
|---|---|
| `POST /api/ingest` | One frame object, **or an array of up to 50** (batched catch-up). `Authorization: Bearer <token>`. Returns `{"ok":true,"accepted":n}`. |

Batched catch-up frames carry a top-level `age_ms` — how long ago the device
captured each one (it has no wall clock, only a relative age; live frames omit
the field). The kit stores every frame at its **capture time**,
`receivedAt − age_ms`, so a drive through a connectivity gap comes back as a
correctly-spread timeline instead of one clump — the same rule the production
cloud applies (including the guard: an `age_ms` over 7 days is treated as
absent).

Query (what your tools GET — no auth, it's your laptop):

| Endpoint | Returns |
|---|---|
| `GET /api/devices` | `{"devices":[{"id","name","created_at","last_seen","vin"}]}` |
| `GET /api/devices/:id/latest` | `{"device_id","name","ts","frame":{…}}` |
| `GET /api/devices/:id/history?from=&to=&interval=` | `{"device_id","from","to","interval_s","points":[{"ts","frame"}]}` — ISO times, downsampled to one point per `interval` seconds (default 5), default range = last hour |
| `GET /api/devices/:id/dtc` | `{"device_id","mil","codes":[{"code","first_seen","last_seen","active"}]}` |
| `GET /api/devices/:id/live` | **Server-Sent Events** — one `data:` message per ingested frame: `{"device_id","ts","frame":{…}}` |
| `GET /healthz` | `{"ok":true, "devices":n, "frames_received":n}` |
| `GET /api/meta` | Kit version, port, ingest URL(s) + token — what the console's start screen shows you to provision |

Read it back with a plain GET (no auth — it's your laptop):

```
curl -s http://127.0.0.1:3000/api/devices
curl -s http://127.0.0.1:3000/api/devices/MYCAR/latest
```

## The telemetry frame

The frame format belongs to **AutoTLM Core** — this kit consumes it verbatim
and so should you. The full contract (field names, units, the PID map) is in
[Core's README](https://github.com/AcidAlchamy/autotlm-core#the-telemetry-frame).
The two rules that matter most when you build on top:

- **Every sub-object is optional.** No GPS fix → no `gps` object at all
  (never a zero-filled one). Null-check `obd` / `gps` / `imu` / `dtc`, always —
  and the fields *inside* them too (the console does).
- **Values are SI end to end** — km/h, °C, kPa. Convert at display time.

Everything the frame carries is stored and served back verbatim — the newer
contract fields (`obd.supported`, `obd.pids` as real JSON numbers, `dtc.freeze`,
`gps.source`, `age_ms`) flow through untouched, and the frame inspector is the
easiest place to watch them arrive.

One quirk to know: a frame that arrives **without** `frame.device.id` isn't
dropped — it lands in a single shared `UNKNOWN` device, so a half-written
sketch still shows up somewhere. Set a device id early.

## Configuration

Everything is an env var with a dev-friendly default:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port for everything |
| `DEVKIT_TOKEN` | `devkit` | Bearer token required on `/api/ingest` |
| `DEVKIT_BUFFER` | `5000` | Frames kept in memory per device (ring buffer) |
| `DEVKIT_PERSIST` | off | `1` = append every frame to a JSON-lines file and replay it on restart |
| `DEVKIT_PERSIST_FILE` | `data/telemetry.jsonl` | Where that file lives |

Container-minded? `docker compose up` builds and runs the same thing on the
same port.

## Testing

```
npm test
```

boots the kit on a scratch port and walks the loop a real device walks:
reject a bad token, ingest the canonical frame from Core's README, read it
back through every query endpoint, and prove a batched catch-up spreads
correctly across history. Plain `node:test` — no framework to learn, and the
test file doubles as executable API documentation. CI runs it on every push.

## The mini-console

The page at `/` is a vanilla-JS client of the kit's own query API — no
framework, no build step, no CDN (fonts are vendored — the console works with
the network cable pulled); view-source *is* the documentation.

- **Instrument cluster** — speed / rpm / coolant dials, throttle / load /
  battery / fuel minis, with amber and red thresholds.
- **Frame inspector** — every frame, pretty-printed live as it arrives, with a
  HOLD button for reading one closely. If you're debugging a sketch, you'll
  live here.
- **Diagnostics** — every trouble code the device has ever reported, decoded
  into plain English, with active / cleared status and first-seen / last-seen.
- **Device** — id, VIN, signal, a lat/lng position readout, and live g-forces.

## Graduating to AutoTLM Cloud

The query endpoints here mirror the AutoTLM Cloud API shapes on purpose.
When your project outgrows the laptop:

1. Register your device with AutoTLM Cloud and get a real device token.
2. Re-provision the device's cloud URL from the DevKit's LAN address to the
   cloud ingest endpoint.
3. Point your client code at the cloud query API — same routes, same response
   shapes, plus what a real backend adds: accounts and per-device tokens,
   trip segmentation, device events, and history that survives a reboot.

Nothing you build against this kit gets thrown away.

## Honest limits (a.k.a. your upgrade path)

This is a teaching starter. If you push it toward production, harden — in
roughly this order:

- **Storage** is an in-memory ring buffer; restart = clean slate (unless you
  enable the JSON-lines flag, which is a log, not a database). First real
  upgrade: SQLite. Second: Postgres.
- **Query endpoints are unauthenticated** — fine on localhost, not fine
  exposed. Add auth before the kit leaves your machine. (`/api/meta` even
  hands back the ingest token — a convenience for *your* console, and one
  more reason not to expose this port as-is.)
- **The ingest token check is a plain string compare** and there's no rate
  limiting, no HTTPS termination, no input schema validation beyond "is it an
  object". A real backend wants all four.
- **One process, no clustering, no metrics.** You know the drill.

## License

MIT. Build something great on it.
