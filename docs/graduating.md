# Graduating to AutoTLM Cloud

What actually changes when your project outgrows the laptop — and the longer
honest list of what this kit deliberately never does.

The short version from the [main README](../README.md#graduating-to-autotlm-cloud)
stands: the DevKit's query endpoints mirror the AutoTLM Cloud API shapes *on
purpose*, so graduating is re-pointing, not rewriting. This page is the
longer version.

## The move itself

1. **Register your device with AutoTLM Cloud** and get a real device token —
   per-device, revocable, tied to your account. The DevKit's single shared
   `DEVKIT_TOKEN` retires.
2. **Re-provision the device's cloud URL** from the DevKit's LAN address to
   the cloud ingest endpoint. That's the same one-field change you made to
   point the device *at* the DevKit in the first place — the device's code
   doesn't change either direction.
3. **Point your client code at the cloud query API** — change the base URL.
   Same routes, same response shapes.

## What stays

- **The frame contract.** It belongs to
  [AutoTLM Core](https://github.com/AcidAlchamy/autotlm-core), not to either
  backend — both consume it verbatim. Everything in
  [Consuming frames](frame-consuming.md) transfers unchanged.
- **The response shapes.** `/api/devices`, `/latest`, `/history`, `/dtc`,
  the SSE live channel — what you built against the
  [query API](query-api.md) ports over by changing the base URL.
- **The timing semantics.** The [age_ms rule](ingest.md#the-age_ms-story) —
  capture-time stamping, the 7-day guard, newest-capture-wins — is the
  production cloud's rule; the DevKit implements it *so that* your
  assumptions survive the move. Batching, the 50-frame cap and the body
  limit match for the same reason.
- **Your device-side code.** Sketches, TLMscript programs, provisioning —
  a cloud URL and a token are the only fields that change.

Nothing you build against this kit gets thrown away. That's the design goal
the whole repo hangs off.

## What changes

- **A real base URL** instead of a LAN address.
- **Real auth, both directions.** Accounts, per-device ingest tokens, and —
  unlike the DevKit — an authenticated *query* side. Your client code adds
  credentials; on the DevKit it never needed any.
- **Someone else keeps it running.** TLS, uptime, backups stop being your
  laptop's problem.

## What Cloud adds

Things a real backend does that a teaching starter shouldn't pretend to:

- **Durable history** — storage that outlives any process, without you
  climbing the [storage ladder](storage.md) yourself.
- **Trip segmentation** — drives grouped into trips, not one endless stream.
- **Device events** — the `/api/events` leg that TLMscript's `alert`
  publishes to (on a DevKit target it 404s harmlessly; the
  [main README](../README.md#feeding-it-from-tlmscript) tells that story).
- **Phone GPS provenance** — the one deliberate read-side divergence. Cloud
  can pair a phone to a device and merge the phone's location into frames at
  read time: its `/devices` and `/latest` carry a `gps_mode` field, and
  enriched fixes arrive with `gps.source: "phone"`. The DevKit is
  single-source and serves frames exactly as pushed, so you *gain* this on
  graduation rather than losing anything — the enriched fixes are still
  complete `gps` objects, and reading `gps.source` is the only seam.

## What the DevKit deliberately doesn't do

The honest list, in one place. None of these are missing features — they're
the line between a starter you can read in an afternoon and a product:

- **No accounts, no users, no per-device tokens** — one shared bearer token
  on ingest, nothing on query.
- **No query-side auth** — and [`/api/meta`](query-api.md#get-apimeta) hands
  the ingest token to anyone who can reach the port. Fine on localhost;
  the reason the port never gets exposed as-is.
- **No TLS, no rate limiting, no schema validation** beyond "is it a JSON
  object under 256 KB".
- **No durable storage by default** — a ring buffer, with a JSONL flag and a
  [SQLite kit](../kits/sqlite/README.md) as the self-serve upgrades.
- **No trips, no events, no phone pairing** — see the Cloud list above.
- **No multi-process story** — one process, no clustering, no metrics.
- **No fake data, ever** — the kit ships empty and only your gear fills it.
  That one it shares with Cloud, and it's a feature.

If you find yourself hardening these one by one, you're either having fun —
in which case the [storage page](storage.md) ends with your next exercise —
or you're building a product, in which case graduation was the cheaper move.

## Related pages

- [Query API](query-api.md) — the shapes that make the move cheap
- [Ingest](ingest.md) — the timing semantics both backends share
- [Storage](storage.md) — the self-hosted ladder, if you'd rather climb than graduate

[← back to the index](README.md)
