# kits/replay — record a real drive once, replay it forever

**The DevKit family ships no fake data. This kit replays YOUR recordings of
YOUR real gear.** There is no sample drive in this folder and never will be —
the first step below is making a recording, and everything after that is just
playing your own telemetry back.

Why you'd want that: a real drive is a perishable test input. You captured a
cold start, a highway merge, the moment a trouble code appeared — and now you
want to develop against that exact stream without going back out to the car.
Record it once with the kit's own persistence flag, then replay it into a
fresh console (or the [SQLite kit](../sqlite/README.md), or anything speaking
the [ingest contract](../../docs/ingest.md)) as many times as you like.

## 1) Make a recording

Turn on the root kit's JSON-lines persistence and drive your real gear:

```
DEVKIT_PERSIST=1 npm start
```

(PowerShell: `$env:DEVKIT_PERSIST="1"; npm start`.)

Every accepted frame is appended to `data/telemetry.jsonl` — one
`{"ts":…,"frame":{…}}` per line, exactly as it arrived. That file is your
recording. Copy it, rename it, keep a shelf of them ("cold-start.jsonl",
"check-engine-day.jsonl"). The format is documented in
[docs/storage.md](../../docs/storage.md).

## 2) Play it back

With a kit running (`npm start` in another terminal):

```
node kits/replay/replay.js --file data/telemetry.jsonl
```

The console fills in and moves like the day you recorded it. Some variations:

```
node kits/replay/replay.js --file drives/cold-start.jsonl --speed 4
node kits/replay/replay.js --file data/telemetry.jsonl --loop
node kits/replay/replay.js --file data/telemetry.jsonl --device A6445000 --target http://127.0.0.1:3801
```

That last one replays a single device's frames into the SQLite kit's port.

## How it works

The replayer reads the JSONL file, then re-POSTs your frames to
`<target>/api/ingest` **one at a time, preserving the original inter-frame
gaps** — each recorded capture-time delta, divided by `--speed`. A two-second
heartbeat replays as a two-second heartbeat; the connectivity gap where your
device buffered replays as a gap. A `\r` progress line tracks n/total,
elapsed time and the recorded timestamp it's up to; Ctrl-C stops cleanly with
a summary (a second Ctrl-C force-quits).

Two honesty rules are built in, and they're the whole point of this kit:

- **Recorded `age_ms` is stripped.** In the
  [frame contract](../../docs/frame-consuming.md), `age_ms` describes the
  *original* transport — "captured this long before the device managed to
  send it". That was true of the drive you recorded, not of this replay, so
  forwarding it would backdate tonight's replay into last week's timeline.
  The receiving kit stamps each frame at arrival instead, and the pacing
  makes those arrivals echo the recording's rhythm.
- **`--as-live` is the default — and the only mode.** The flag is accepted
  for clarity, but there's no "fast batch" alternative, because batching a
  replay up with synthetic `age_ms` values would claim the frames were
  captured during a connectivity gap that never happened. Fabricated
  timeline; we don't.

Frames replay in file order (the order the kit accepted them). A backdated
catch-up frame can sit after a live one with an older timestamp — that
negative delta is clamped to zero rather than time-traveling.

## Configuration

All flags, no env vars:

| Flag | Default | Meaning |
|---|---|---|
| `--file <path>` | *(required)* | JSONL recording made by `DEVKIT_PERSIST=1` |
| `--target <url>` | `http://127.0.0.1:3000` | The kit to replay into |
| `--token <token>` | `devkit` | Ingest bearer token (must match the target's `DEVKIT_TOKEN`) |
| `--device <id>` | *(all devices)* | Replay only this device's frames (frames recorded without a `device.id` filter as `UNKNOWN`, same as the kit files them) |
| `--speed <n>` | `1` | Playback rate — `2` = twice as fast, `0.5` = half speed |
| `--loop` | off | Start over when the recording ends, until Ctrl-C |
| `--as-live` | *(the default)* | Alias for the standard pacing — see above |

Exit code is nonzero on a bad token, an unreachable target, or an
empty/unreadable recording — each with a message saying what to fix.

## Testing

```
node --test kits/replay/test/replay.test.js
```

builds a three-frame recording from the canonical Core frame, boots the real
root server on a scratch port, and proves the promises: every frame lands,
the wall time respects the scaled gaps, arrivals spread across history
buckets, and a recorded `age_ms` never makes it through. It runs as part of
the root `npm test` too.

## Honest limits

- **Replayed frames are re-stamped at arrival — by design.** History shows
  the replay's timeline at the replay's clock, not the original drive's
  dates. The *rhythm* is yours; the wall-clock times are today's.
- **One file, no editing.** No slicing, trimming or merging — though the file
  is just lines of JSON, so `head`, `tail` and a text editor already are your
  editing suite.
- **`--loop` seams are back-to-back.** The last frame of one pass and the
  first frame of the next replay with no gap between them — we won't invent
  an interval the recording doesn't contain.
- **It aborts on the first error** rather than retrying — a replay that
  silently dropped frames would be a worse lie than a loud stop.
- **A long real gap replays long.** You parked for an hour, the replay waits
  an hour (÷ `--speed`). That's the point — compress with `--speed` when you
  don't want the coffee break.

← back to the [DevKit README](../../README.md) · related:
[docs/storage.md](../../docs/storage.md) ·
[docs/ingest.md](../../docs/ingest.md)
