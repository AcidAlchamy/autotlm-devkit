# AutoTLM DevKit — Update Log

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
