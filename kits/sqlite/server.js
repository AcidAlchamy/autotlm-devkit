/* AutoTLM DevKit — SQLite kit: the core kit with a real database under it.
 *
 *   node kits/sqlite/server.js     (run from the repo root)
 *
 * Same HTTP surface, same console, same frame contract — but frames land in a
 * SQLite file instead of RAM, so a restart no longer wipes your history. This
 * is the "first real upgrade" the core README promises, done for you and kept
 * readable so you can see exactly what upgrading storage means: src/db.js
 * replaces the in-memory store, and everything else mirrors the core kit's
 * src/api.js — the response shapes are the contract, so read the comments
 * there for the full story on each route.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { PRODUCT_NAME, DEVKIT_VERSION } from "../../src/config.js";
import { openDb } from "./src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  /** HTTP port — parked away from the core kit's 3000 so both can run at once. */
  port: Number(process.env.PORT || 3801),

  /**
   * Bearer token your device must send on POST /api/ingest. Same caveat as
   * the core kit: the default is a local-dev convenience — override it the
   * moment this port is reachable by anyone but you.
   */
  token: process.env.DEVKIT_TOKEN || "devkit",

  /**
   * Max frames KEPT ON DISK per device — the ring buffer's durable cousin.
   * Ten times the core default, because disk is cheap where RAM wasn't.
   * Oldest rows are deleted as new ones land (in batches, so the count can
   * briefly run a little over — see src/db.js).
   */
  bufferFrames: Number(process.env.DEVKIT_BUFFER || 50000),

  /**
   * The database file. The default lives inside this kit's own folder (the
   * repo's .gitignore already keeps data/ out of commits) no matter which
   * directory you launch from; a DEVKIT_DB override resolves against your
   * working directory like any path you type.
   */
  dbFile: process.env.DEVKIT_DB
    ? path.resolve(process.env.DEVKIT_DB)
    : path.join(__dirname, "data", "telemetry.db"),
};

const db = openDb(config.dbFile, { bufferFrames: config.bufferFrames });

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" })); // matches the device-side contract

// The same mini-console the core kit serves, straight from the ROOT public/
// folder — this relative hop works because the kit runs from the monorepo
// clone, where ../../public is two levels up. The console only speaks to the
// query API, and ours answers in identical shapes, so it needs no changes.
app.use(express.static(path.join(__dirname, "..", "..", "public")));

/* ---------- live channel plumbing (SSE) ---------- */

// deviceId -> Set<res> of open event streams (same pattern as src/api.js)
const listeners = new Map();

function broadcast(deviceId, payload) {
  const subs = listeners.get(deviceId);
  if (!subs) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of subs) {
    // a client that vanished mid-write must never take the server down
    try {
      res.write(msg);
    } catch {
      subs.delete(res);
    }
  }
}

/* ---------- ingest ---------- */

app.post("/api/ingest", (req, res) => {
  const auth = req.get("authorization") || "";
  if (auth !== `Bearer ${config.token}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // One frame object, or an array of up to 50 (batched catch-up).
  const frames = Array.isArray(req.body) ? req.body : [req.body];
  if (frames.length > 50) {
    return res.status(400).json({ error: "too_many_frames" });
  }

  const receivedAt = Date.now();
  let accepted = 0;
  for (const frame of frames) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) continue;
    // The age_ms rule, verbatim from the core kit: catch-up frames carry how
    // long ago the device captured them, so we store each at its capture
    // time, ts = receivedAt − age_ms — an offline gap lands as a spread
    // timeline, not a clump. Ages over 7 days are treated as absent so a
    // corrupt value can't backdate history into the far past.
    const age =
      typeof frame.age_ms === "number" &&
      frame.age_ms >= 0 &&
      frame.age_ms <= 7 * 24 * 3600_000
        ? frame.age_ms
        : 0;
    const ts = new Date(receivedAt - age).toISOString();
    const dev = db.addFrame(frame, ts);
    accepted++;
    broadcast(dev.id, {
      device_id: dev.id,
      ts,
      frame,
    });
  }
  if (!accepted) return res.status(400).json({ error: "no_valid_frames" });
  res.json({ ok: true, accepted });
});

/* ---------- query ---------- */

app.get("/api/devices", (_req, res) => {
  res.json({ devices: db.listDevices() });
});

app.get("/api/devices/:id/latest", (req, res) => {
  const out = db.latest(req.params.id);
  if (!out) return res.status(404).json({ error: "no_frames" });
  res.json(out);
});

app.get("/api/devices/:id/history", (req, res) => {
  res.json(
    db.history(req.params.id, {
      from: req.query.from,
      to: req.query.to,
      intervalS: req.query.interval,
    })
  );
});

app.get("/api/devices/:id/dtc", (req, res) => {
  res.json(db.dtcReport(req.params.id));
});

app.get("/api/devices/:id/live", (req, res) => {
  const id = req.params.id;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");

  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(res);

  // keep-alive comment so proxies don't reap the idle stream
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { cleanup(); }
  }, 25_000);
  function cleanup() {
    clearInterval(ping);
    listeners.get(id)?.delete(res);
  }
  // browsers close SSE streams rudely (tab kill, sleep, network flap) —
  // treat every teardown signal as routine, never as a crash
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("error", cleanup);
});

/* ---------- meta ---------- */

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ...db.stats() });
});

// Same shape as the core kit's /api/meta — the console's start screen reads
// product, ingest_urls and token from here. Same token caveat, too: a local
// dev convenience, not something to expose beyond localhost/LAN.
app.get("/api/meta", (_req, res) => {
  res.json({
    product: PRODUCT_NAME,
    kit: "DevKit (sqlite)",
    version: DEVKIT_VERSION,
    port: config.port,
    ingest_urls: ingestUrls(),
    token: config.token,
    ...db.stats(),
  });
});

/**
 * Every URL a device on the same network could reach this kit at.
 * A twin of the core kit's ingestUrls rather than an import — that one is
 * wired to the core config's port default, and this kit listens elsewhere.
 */
function ingestUrls() {
  const urls = [`http://127.0.0.1:${config.port}/api/ingest`];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) {
        urls.push(`http://${i.address}:${config.port}/api/ingest`);
      }
    }
  }
  return urls;
}

app.listen(config.port, () => {
  const urls = ingestUrls();
  console.log(`
  ${PRODUCT_NAME} DevKit v${DEVKIT_VERSION} — SQLite kit (durable storage)
  ──────────────────────────────────────────────────────────
  console   http://localhost:${config.port}
  ingest    ${urls.join("\n            ")}
  token     ${config.token}   (override: DEVKIT_TOKEN=...)
  database  ${config.dbFile}
  ──────────────────────────────────────────────────────────
  Same API and console as the core kit, one difference: frames
  land in SQLite. Stop it, start it — your history is still here.
`);
});
