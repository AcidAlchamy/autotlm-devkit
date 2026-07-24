# Live streaming (SSE)

How `GET /api/devices/:id/live` pushes every frame to you the moment it's
ingested — and how to consume it from a browser or from Node.

The code behind this page is the `/live` route and the broadcast plumbing at
the top of [`src/api.js`](../src/api.js) — about thirty lines for the whole
server side.

## SSE in thirty seconds

Server-Sent Events is the simplest push protocol that could work: the client
makes a normal HTTP GET, and the server just… never finishes the response.
It keeps the connection open and appends lines of plain text
(`Content-Type: text/event-stream`) whenever it has something to say. No
handshake, no framing bytes, no library required on either end — it's
newline-delimited text over the HTTP you already have. (WebSockets earn their
complexity when the *client* needs to talk back; a telemetry feed doesn't.)

## The wire format this kit emits

Open a stream with curl and watch (`-N` disables buffering):

```
curl -N http://127.0.0.1:3000/api/devices/A6445000/live
```

Everything you will ever see on it:

```
retry: 3000

: ping

data: {"device_id":"A6445000","ts":"2026-07-24T17:41:58.112Z","frame":{...}}

```

Line by line:

- **`retry: 3000`** — sent once, immediately on connect: the server's
  suggested reconnect delay in milliseconds. Browsers honor it automatically.
- **`: ping`** — a comment (any line starting with `:`), sent every 25
  seconds so proxies don't reap the idle connection. Safe to ignore; per the
  SSE spec, comments never reach your message handler.
- **`data: {...}`** — one event's payload, followed by a **blank line**,
  which is what actually dispatches the event. The payload is always one JSON
  object: `{ device_id, ts, frame }` — the same `ts` and verbatim `frame`
  the store keeps, broadcast at the moment of ingestion.

That's the entire grammar. The kit never sends `event:` or `id:` fields, so
there are no named events and no resume cursor (more on that below).

Two behaviors worth knowing:

- **Subscribing to a device that doesn't exist yet is fine.** The stream
  opens and waits; the first frame that device ever pushes arrives on it.
- **Catch-up frames are broadcast too**, with their backdated `ts` — a batch
  upload after a connectivity gap arrives on the stream as a burst. Clock
  any time-based logic on `ts`, not on arrival (see
  [the age_ms story](ingest.md#the-age_ms-story)).

## Consuming from a browser

The browser has this built in — `EventSource` handles connecting, parsing and
reconnecting for you:

```js
const es = new EventSource("/api/devices/A6445000/live");
es.onmessage = (e) => {
  const msg = JSON.parse(e.data); // { device_id, ts, frame }
  render(msg.frame);
};
es.onerror = () => {
  // fired on any drop; EventSource is already reconnecting — just show state
};
```

This is exactly what the [mini-console](console.md) does
([`public/app.js`](../public/app.js), `selectDevice`) — plus one trick worth
stealing: on open it first GETs `/latest` so the page isn't blank between
frames, *then* attaches the stream. Snapshot first, live after.

## Consuming from Node

Node ships no `EventSource`, and that turns out to be a feature: the client
is small enough to write yourself and know exactly what you're running. The
[alerts kit](../kits/alerts/README.md) does precisely this — the `subscribe`
function in [`kits/alerts/alerts.js`](../kits/alerts/alerts.js) is the whole
protocol, hand-rolled and commented, in about forty lines. It's the worked
example this page points at rather than repeats; the shape of it:

1. `fetch` the URL and read the response body as a stream.
2. Decode chunks (a streaming `TextDecoder` — a UTF-8 character can split
   across chunks), append to a line buffer, split on `\n`.
3. `data:` lines accumulate; a **blank line** means "event complete — hand it
   over"; `retry:` updates your reconnect delay; `:` comments fall through
   ignored.
4. On any error or hang-up: reconnect after the server-suggested delay,
   doubled per consecutive failure, capped (the kit caps at 30 s) — so a dead
   server costs one probe every 30 seconds, not a tight loop.

Run it against a live kit and watch rules fire (it needs a rules file —
copy the shipped example first, or point `--rules` at it):

```
cp kits/alerts/rules.example.json kits/alerts/rules.json
node kits/alerts/alerts.js --base http://127.0.0.1:3000 --device A6445000
```

## Reconnect behavior — and what you miss

The kit sends no `id:` fields, so there is no `Last-Event-ID` resume: frames
ingested while you were disconnected are simply not on the stream when you
come back. That's a deliberate simplification, and the fix is the same
snapshot-first pattern from above — on (re)connect, GET
[`/latest`](query-api.md#get-apidevicesidlatest) for current state or
[`/history`](query-api.md#get-apidevicesidhistory) for the gap, then let the
stream take over. The store is the source of truth; the stream is just the
tap on it.

On the server side, disconnects are routine, not errors: the kit treats every
teardown signal (tab kill, laptop sleep, network flap) as normal cleanup, and
a client that vanishes mid-write can never take the server down.

## Related pages

- [Query API](query-api.md) — the snapshot endpoints you pair with the stream
- [Ingest](ingest.md) — where the broadcast frames come from
- The [alerts kit](../kits/alerts/README.md) — a complete SSE consumer that
  does something useful

[← back to the index](README.md)
