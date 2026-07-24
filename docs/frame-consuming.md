# Consuming frames

The rules for reading a telemetry frame without crashing, guessing, or
inventing data — and a worked snippet you can lift.

**The frame contract belongs to [AutoTLM Core](https://github.com/AcidAlchamy/autotlm-core).**
Field names, units, and the PID map are documented in
[Core's README](https://github.com/AcidAlchamy/autotlm-core#the-telemetry-frame),
and that document is authoritative — this kit consumes the contract verbatim
and never extends it. This page is the *consumer's* half: what the contract
guarantees you, and the habits that keep your code alive when a field isn't
there.

For orientation, the canonical example frame (the one the smoke test ingests
and [Query API](query-api.md#get-apidevicesidlatest) shows in full) has this
shape:

```
{
  source: "device",
  device: { id, ... },                      ← identity & link quality
  obd:    { connected, speed_kph, rpm, coolant_c, ..., vin, pids: {...} },
  dtc:    { mil, codes: [...] },            ← trouble codes
  gps:    { fix, lat, lng, ..., sats },     ← position
  imu:    { ax, ay, az, gx, gy, gz },       ← motion
  age_ms                                    ← only on buffered catch-up frames
}
```

## The consumer rules

### 1. Absent means "no data this cycle" — never zero

Every sub-object is **optional**. No GPS fix → no `gps` object at all, never
a zero-filled one. An engine off → maybe no `obd`. A frame with nothing but
`device` is legal. Render "—", skip the rule, leave the cell empty — whatever
your context's honest answer to "I don't know" is, that's what absent maps
to. Treating absent as `0` puts fake zeros on dials and fires
`coolant_c < 20` alerts at parked cars.

### 2. Null-check *inside* sub-objects too

`gps` being present doesn't promise every field in it. A fix flag without
coordinates, an `imu` missing an axis, an `obd` with `rpm` but no
`coolant_c` — all legal, all "no data for the missing bit". The console's
own habit ([`public/app.js`](../public/app.js)) is the one to copy:

```js
gps && gps.fix && typeof gps.lat === "number" && typeof gps.lng === "number"
```

— check the object, then check the field, and only then use it.

### 3. Values are SI, end to end

km/h, °C, kPa, volts, g. No imperial anywhere in a frame; convert at display
time if your users want miles. Store and compare in SI so two consumers never
disagree about what a number means.

### 4. PIDs: uppercase-hex keys, real JSON numbers

`obd.pids` is a map of two-character **uppercase** hex PID keys to numeric
values — `{ "04": 23, "0C": 1840, "2F": 61 }`. Look up `"0C"`, not `"0c"`
and not `12`. The values are plain JSON numbers, already scaled to SI —
no bit-fiddling on the consumer side. `obd.supported`, when present, lists
the PIDs the vehicle advertises, in the same uppercase-hex spelling.

### 5. The UNKNOWN device

A frame that arrives without `frame.device.id` isn't dropped — the kit merges
every such frame into one shared device literally named `UNKNOWN`
([`src/store.js`](../src/store.js), `addFrame`). A half-written sketch beats
silent data loss. Consumer side, that means: `UNKNOWN` in a device list is a
real thing you may encounter, and it usually means somebody's sketch isn't
setting an id yet.

### 6. `age_ms` describes transport, not content

A top-level `age_ms` marks a buffered catch-up frame; the kit already used it
to backdate `ts` at ingest ([the age_ms story](ingest.md#the-age_ms-story)).
Consumer rules that follow from it: trust `ts` as capture time, clock any
duration logic on `ts` rather than on arrival, and if you re-send frames
anywhere, strip the recorded `age_ms` — it described the original journey,
not yours (the [replay kit](../kits/replay/README.md) does exactly this).

## Walking a frame safely — a worked snippet

Ten lines that encode rules 1 and 2 and never throw, whatever the frame
looks like:

```js
/** Walk a dotted path ("obd.coolant_c", "obd.pids.0C") into a frame.
 *  Any missing hop returns undefined — absent data, not an error. */
function walk(frame, dotted) {
  let v = frame;
  for (const key of dotted.split(".")) {
    if (v == null || typeof v !== "object") return undefined;
    v = v[key];
  }
  return v;
}

const coolant = walk(frame, "obd.coolant_c"); // number, or undefined
const fuel    = walk(frame, "obd.pids.2F");   // uppercase-hex PID key
const milOn   = walk(frame, "dtc.mil") === true;

// absent ≠ zero — say "no data", don't invent a reading
render(coolant != null ? `${coolant} °C` : "—");
```

This is the same `walk` the [alerts kit](../kits/alerts/README.md) evaluates
every rule with ([`kits/alerts/alerts.js`](../kits/alerts/alerts.js)) — one
function is enough to make an entire rules engine contract-safe.

Two more habits from the kit's own consumers worth stealing:

- **`dtc.codes` may be absent even when `dtc` is present** — reach for it as
  `Array.isArray(dtc.codes) ? dtc.codes : []`, and remember a frame *with* a
  `dtc` object is authoritative: codes it doesn't list have cleared.
- **Strict comparisons.** `"1840"` is not `1840`; the alerts kit's `==` op is
  strict equality on purpose. Coercion hides contract violations you'd
  rather see.

## Related pages

- [Core's README](https://github.com/AcidAlchamy/autotlm-core#the-telemetry-frame) —
  the contract itself, authoritative
- [Ingest](ingest.md) — how frames get in, and the age_ms rule in full
- [Query API](query-api.md) — the shapes frames come back in
- The [alerts kit](../kits/alerts/README.md) and [CSV kit](../kits/csv/README.md) —
  two complete consumers built on these rules

[← back to the index](README.md)
