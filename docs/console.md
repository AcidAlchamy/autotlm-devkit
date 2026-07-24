# The mini-console

How the no-build console at `/` works, and where to start when you rip it
apart to build your own UI.

The console is three files in [`public/`](../public/) — `index.html`,
`styles.css`, `app.js` (plus `dtc.js` for fault decoding) — served statically
by the kit. No framework, no build step, no CDN. **View-source is the
documentation**, and this page is the guided tour of it.

## The data flow

The console is a plain client of the kit's own [query API](query-api.md) —
it has no private endpoints, which is exactly what makes it replaceable:

1. **`GET /api/meta`** on boot — fills the start screen with the real ingest
   URL + token to provision a device with, and brands the page (the product
   name lives in one constant at the top of `app.js`).
2. **`GET /api/devices`**, polled every 5 s — keeps the device picker
   current. First device to ever push a frame gets auto-selected.
3. **Snapshot first, live after.** Selecting a device GETs
   **`/latest`** immediately — so the console isn't blank when you open it
   between drives — then attaches **`/live`** with a browser `EventSource`
   and repaints on every frame ([SSE, in full](sse.md)).
4. **`GET /dtc`** fills the Diagnostics table — reloaded only when the code
   set (or freeze-frame content) actually changes, not on every frame. The
   live stream is the change detector; the table is the detail view.

Every render null-checks the frame per the
[consumer rules](frame-consuming.md) — the console is the reference consumer,
so its habits are the ones to copy.

## The dial trick

Each gauge is an SVG arc **drawn once** at startup: a 240° path whose length
we know, with `stroke-dasharray` set to that length. Moving the needle never
redraws the path — it just sets `stroke-dashoffset`, so the arc reveals
exactly the fraction the value calls for, and a CSS transition makes the
sweep smooth. One cheap property update per frame per dial; the browser
animates it on the compositor.

The glow under the arc is the same trick again: a wider, fainter twin of the
arc, updated in lockstep. It is **deliberately not an SVG drop-shadow
filter** — filter effects rasterize per frame on machines without GPU
acceleration, and on such a machine a handful of glowing dials costs literal
seconds on first paint. Two strokes cost nothing. (The comment in
[`public/styles.css`](../public/styles.css) tells the same story next to the
code.) Warn and critical states just swap the stroke color via a class —
amber past the warn threshold, red past crit.

## Theming and fonts

- **Theming is one attribute.** Every color in `styles.css` is a CSS variable
  on `:root`, with a `[data-theme="light"]` override block. The toggle flips
  `document.documentElement.dataset.theme` and saves the choice to
  `localStorage`; an inline script in `index.html` restores it before first
  paint (falling back to `prefers-color-scheme`), so there's no flash of the
  wrong theme. Restyling the whole console = editing variables.
- **Fonts are vendored.** The two families (Chakra Petch, IBM Plex Mono)
  ship as woff2 files in `public/fonts/` with their license — no CDN, no
  third-party request. The console works with the network cable pulled,
  which is not hypothetical for a tool aimed at a bench.

## What the panels show

- **Instrument cluster** — speed / rpm / coolant dials, throttle / load /
  battery / fuel minis (fuel reads PID `2F`), and OBD / GPS / IMU / MIL
  badges that light per frame.
- **Frame inspector** — every frame pretty-printed live, with a HOLD button
  that freezes the readout for close reading while the stream runs on. If
  you're debugging a sketch, you'll live here.
- **Diagnostics** — every trouble code on the device's ledger, decoded into
  plain English (`dtc.js` — a dictionary of common codes plus a structural
  SAE-format decode for everything else), with active / cleared status and
  first / last seen.
- **Device** — id, VIN, signal, position, live g-forces, and the sensor
  menu (below).

### Freeze frames in Diagnostics

When a frame's `dtc.freeze` carries a PID snapshot for a stored code — the
readings the moment the fault set — the console merges it into the DTC table
**client-side**: under the code's row appears a quiet mono sub-line like

```
at fault: 1320 rpm · 20 km/h · coolant 89 °C · load 27 % · throttle 14 %
```

decoded with a small local PID map (rpm, speed, coolant, load, throttle,
fuel, intake temp, module voltage; anything unmapped falls back to
`PID 0x<key>=<val>`). This is display-side sugar only — the kit's API serves
the frame verbatim and stays shape-identical to Cloud; the merge and decode
happen in `app.js`.

### The sensor menu

When a frame carries `obd.supported` — the PIDs the vehicle advertises — the
Device panel gains a `sensors` row ("N advertised") and a wrap of tiny mono
chips listing the hex PIDs (capped, with a `+n more` overflow). Handy for
answering "can this car even report fuel level?" without leaving the console.

### The CATCH-UP tag

A frame that arrives with `age_ms > 0` is a buffered catch-up frame — its
`ts` is its backdated capture time, not "now" (see
[the age_ms story](ingest.md#the-age_ms-story)). The inspector marks the
moment visibly: a small amber `CATCH-UP` tag next to the timestamp, clearing
on the next live frame, with a tooltip saying how far behind arrival the
capture was. When a device comes back from a dead zone and bursts its
buffer, you can *watch* the timeline catch up. (`gps.source`, when present,
similarly rides along on the POSITION readout — `… · 12 sats · internal`.)

## Rip it apart

The console is deliberately the most disposable part of the kit — pipeline
node 03 on its own footer says so. Pointers for replacing it:

- **The API client is ~10 lines** (`API` at the top of `app.js`): four GETs
  and an `EventSource`. That object is the entire coupling between the UI
  and the kit — start your own UI by lifting it.
- **The contract is the [query API](query-api.md), not this DOM.** Anything
  that speaks those shapes is a valid console — a React app, a TUI, a wall
  display. The [alerts kit](../kits/alerts/README.md) is "a console with no
  screen" built on the same two ideas (snapshot + stream).
- **Steal the patterns, not the files**: snapshot-first-then-SSE, repaint
  only what changed (the DTC table's change-key), null-check per the
  [consumer rules](frame-consuming.md), and keep expensive paint effects off
  the per-frame path.
- **Serving your own UI**: drop files into `public/` (the kit serves it
  statically), or serve your UI anywhere and point it at the kit's base URL —
  the query API is unauthenticated on your laptop, and CORS is yours to add
  if you split origins (the stock console avoids the question by being
  same-origin).

## Related pages

- [Query API](query-api.md) — everything the console reads
- [Live streaming (SSE)](sse.md) — the channel behind the live repaints
- [Consuming frames](frame-consuming.md) — the null-checking discipline

[← back to the index](README.md)
