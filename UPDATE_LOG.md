# AutoTLM DevKit — Update Log

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
