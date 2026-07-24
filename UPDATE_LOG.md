# AutoTLM DevKit — Update Log

## 2026-07-24 — AutoTLM DevKit v0.4.0: one download is now a whole family

The DevKit grows from a starter into a **family** — same clone, zero new
dependencies, every piece tested and documented. New under `kits/`:
**sqlite** (the "first upgrade" done for you — the same API and console backed
by a real database file that survives restarts, on Node's built-in SQLite),
**alerts** (watch the live stream and fire threshold / new-trouble-code alerts
at your console, a webhook, or Discord — built on a hand-rolled SSE client
that doubles as a teaching artifact), **csv** (any device's history straight
into a spreadsheet), and **replay** (record a real drive once, replay it
forever at original cadence — ships no data, replays *your* recordings of
*your* gear). The console levels up too: freeze-frame snapshots decoded under
each trouble code ("what was happening when the light came on"), the car's
advertised sensor menu as PID chips, GPS provenance, and a CATCH-UP tag on
buffered frames. And a new **docs/** shelf — eight fact-checked pages from
ingest and the query API down to the SSE wire grammar and a
ring-buffer-to-SQLite-to-Postgres storage ladder. 38 tests across the family,
green in CI.

The DevKit README now shows how little it takes to feed the console: a five-line
[TLMscript](https://github.com/AcidAlchamy/tlmscript) heartbeat that compiles to
a native AutoTLM Core sketch and streams a frame every two seconds — no C++.
Alongside it, an honest note on the one place the kit deliberately diverges from
AutoTLM Cloud: the cloud's phone-as-a-GPS-source merge (`gps_mode`, read-time
`gps.source:"phone"` enrichment) is a superset a single-source local kit doesn't
mimic, so you *gain* it on graduation rather than losing anything. And the repo
finally has git tags — v0.2.0 and v0.3.0 are tagged with a v0.3.0 GitHub release,
so the downloads page can link a real release like the rest of the family.

## 2026-07-15 — AutoTLM DevKit v0.3.0: timelines that survive the tunnel, tests, and full offline

The DevKit now keeps time the way the production cloud does: batched catch-up
frames (the ones your One buffers through a parking garage) land at their real
**capture time** via the frame's new `age_ms`, so an offline gap comes back as
a correctly-spread drive timeline instead of one clump — graduate to AutoTLM
Cloud and the behavior doesn't change. The kit also gains a spine: `npm test`
boots it and walks the whole device loop (auth, the canonical Core frame,
every query endpoint, the catch-up spread), running in CI on every push. And
it now works with the network cable pulled — fonts are vendored, no CDN calls
from a local tool. Plus a defensive-rendering pass in the console and two
stale simulator references scrubbed (the DevKit is the receiving stage — real
gear only).

## 2026-07-13 — AutoTLM DevKit v0.2.0: the stage, set for your real gear

The DevKit sharpens to its real purpose: it's the **receiving stage**, not a
data source. Out goes the drive simulator — the only thing that lights this
console up is real telemetry from your own gear (an AutoTLM One reading a real
car, or the Car-Emulator on your bench). Download it, `npm start`, and the
console opens ready and waiting, showing the exact ingest URL + token to
provision your One with. It now surfaces the last frame the moment you open it —
so a device that's currently off still shows its last-known state — then updates
live as new frames land. A cleaner, more honest starter: a real backend for
real data, nothing faked.

## 2026-07-13 — AutoTLM DevKit v0.1.0: your car's backend, on your laptop

The AutoTLM developer family grows: the **DevKit** is a free, MIT-licensed
starter backend + live mini-console for AutoTLM One developers. One
`git clone`, one `npm install`, one `npm start` — and your sketches have a
working receiving end with live cockpit gauges, a raw frame inspector, and
plain-English fault decoding, all on your own machine. No cloud account, no
hardware even (a built-in drive simulator lights it up out of the box), and
when you outgrow the laptop, everything you built ports straight to AutoTLM
Cloud — the query API speaks the same shapes. Docker included for the
container-minded.
