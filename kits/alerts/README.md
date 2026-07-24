# kits/alerts — watch the stream, act on it

A zero-dependency watcher that subscribes to a device's live channel and
evaluates a small JSON rules file against every frame as it lands — a console
line always, a webhook POST and/or a Discord message when a rule asks for one.

## Quickstart

From the repo root, with the core kit (or the [SQLite kit](../sqlite/README.md))
already running and your device pushing to it:

```
cp kits/alerts/rules.example.json kits/alerts/rules.json
node kits/alerts/alerts.js --base http://127.0.0.1:3000
```

(Windows: `copy kits\alerts\rules.example.json kits\alerts\rules.json`.)

No `--device`? The watcher asks `/api/devices` and picks the most recently
seen one — it prints which. And like everything in this repo, nothing fires
until your gear pushes real frames: this kit evaluates telemetry, it doesn't
invent any.

## How it works

One file, three parts — read [alerts.js](alerts.js) top to bottom:

1. **A hand-rolled SSE client.** Node ships no `EventSource`, and that turns
   out to be a feature: Server-Sent Events is just a never-ending HTTP
   response of `data:` lines dispatched by blank lines, and the `subscribe`
   function is the whole wire protocol in about forty commented lines over
   global `fetch` — with the same reconnect manners a browser has (the
   server's `retry:` hint honored, exponential backoff, capped at 30 s).
   [docs/sse.md](../../docs/sse.md) walks the protocol; `subscribe` is its
   worked example.
2. **A rule engine.** Threshold rules walk a dotted path into the frame —
   null-safely, because every sub-object in the Core contract is optional —
   and track how long the condition has held (`for_s`) and when the rule last
   fired (`cooldown_s`). DTC rules diff `dtc.codes` against the previous
   dtc-carrying frame and fire on codes that newly appear. Timing runs on
   each frame's *capture* timestamp, so a batched catch-up evaluates with
   honest timing.
3. **Actions.** Every fire logs to the console. `webhook` and `discord` are
   opt-in extras per rule, delivered best-effort: one try, one retry, then a
   log line — a flaky endpoint can never crash the watcher.

Because every kit serves the same query API (and AutoTLM Cloud mirrors it —
see [docs/query-api.md](../../docs/query-api.md)), `--base` can point at any
of them.

## The rules file

A JSON array. Two rule types.

### Threshold rules

```json
{ "path": "obd.coolant_c", "op": ">", "value": 105, "for_s": 10,
  "cooldown_s": 300, "message": "Coolant {value}°C — over 105" }
```

| Field | Required | Meaning |
|---|---|---|
| `path` | yes | Dotted path into the frame: `obd.coolant_c`, `gps.speed_kph`, `obd.pids.0C`, … |
| `op` | yes | One of `>` `<` `>=` `<=` `==` `!=`. Ordering ops are number-to-number only; `==`/`!=` are strict (`"1840"` is not `1840`) |
| `value` | yes | What to compare against |
| `for_s` | no (0) | The condition must hold this many seconds before firing; `0` = instant. A missing reading resets the clock — continuous evidence or no alarm |
| `cooldown_s` | no (0) | Minimum gap between fires of this rule |
| `message` | no | Alert text, with interpolation (below) |
| `webhook` | no | URL to POST the alert to as JSON |
| `discord` | no | Discord webhook URL |

### DTC rules

```json
{ "type": "dtc", "cooldown_s": 0, "message": "New trouble code: {codes}" }
```

Fires when a code appears in `dtc.codes` that wasn't in the previous
dtc-carrying frame's. The first frame that reports codes seeds the baseline
*without* firing — attaching to a car with stored codes shouldn't page you
about history — and a frame with no `dtc` object at all means "no data this
cycle", never "codes cleared". `cooldown_s`, `message`, `webhook` and
`discord` work exactly as above.

### Message interpolation

| Token | Becomes |
|---|---|
| `{value}` | The observed value (threshold) or the new code(s) (dtc) |
| `{codes}` | The newly appeared code(s), comma-joined (dtc rules) |
| `{device}` | The device id |
| `{path}` | The rule's path (`dtc.codes` for dtc rules) |

A token with nothing to say is left as-is, so a template mistake is visible
instead of silently blank.

### Actions

Console output is not optional — every fire prints. Per rule you can add:

- `"webhook": "https://…"` — POSTs
  `{"device_id", "rule", "message", "value", "ts"}` as JSON. `rule` is a
  human-readable id like `obd.coolant_c > 105` (or `dtc`), `ts` is the
  firing frame's capture time.
- `"discord": "https://…"` — POSTs `{"content": message}`, the shape a
  Discord webhook URL expects. Paste the URL from your channel's
  *Integrations → Webhooks* and the alert lands in chat.

Deliveries get a 5 s timeout and **at most one retry**; a failure is logged
and dropped. The example file uses `https://example.com/hook` placeholders —
swap in your own endpoints.

## Configuration

Flags, not env vars — this is a CLI:

| Flag | Default | Meaning |
|---|---|---|
| `--base` | `http://127.0.0.1:3000` | Kit (or cloud) base URL to consume |
| `--device` | most recently seen | Device id to watch |
| `--rules` | `kits/alerts/rules.json` | Rules file — start from [rules.example.json](rules.example.json) |

## The device-side cousin: TLMscript

Device-side alerting is [TLMscript](https://github.com/AcidAlchamy/tlmscript)'s
job — `when mil: alert "..."` runs on the AutoTLM One itself, before any
backend is involved. This kit is the same idea server-side: rules over the
stream *after* it lands, where a fire can also reach webhooks and Discord.
They stack nicely — let the device catch the urgent stuff, let this watcher
do the slow trends and the notifications.

## Testing

```
node --test kits/alerts/test/alerts.test.js
```

fakes the API with an in-process server (a device listing, an SSE stream of
three canonical frames, webhook capture endpoints) and runs the real
`alerts.js` against it: threshold fires once with the cooldown respected,
the dtc rule fires for the newly appeared code only, and both delivery
shapes are asserted. It also runs as part of the root `npm test`.

## Honest limits

- **One device per process.** Watching a fleet = one watcher each (or your
  own loop over `subscribe` — it's right there).
- **State is in-memory.** A restart forgets `for_s` clocks, cooldowns and
  the dtc baseline — the next dtc-carrying frame re-seeds it silently.
- **No history backfill.** Only frames that arrive while the watcher runs
  are evaluated; a condition that came and went while it was down never fires.
- **`for_s` resolves at your push cadence.** Pushing every 2 s, `for_s: 10`
  fires on the first frame at least 10 s into the condition — not at 10.000 s.
- **Best-effort delivery.** 5 s timeout, one retry, no queue — an alert that
  can't be delivered twice is gone (the console line survives).
- **No auth on the query side** — same as the kits themselves. If your
  `--base` target requires auth headers to read, this watcher doesn't send
  any yet.

← back to the [repo README](../../README.md) · [docs/sse.md](../../docs/sse.md) ·
[docs/query-api.md](../../docs/query-api.md)
