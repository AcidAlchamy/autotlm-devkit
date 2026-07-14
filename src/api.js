/* AutoTLM DevKit — the HTTP surface.
 *
 * Two halves, same as the real cloud:
 *   ingest (what your device POSTs)  — POST /api/ingest, bearer-token auth
 *   query  (what your tools GET)     — /api/devices, /latest, /history, /dtc,
 *                                      and an SSE live channel per device
 *
 * The query endpoints mirror the AutoTLM Cloud response shapes on purpose:
 * anything you build against this kit graduates to the cloud by changing
 * the base URL, nothing else.
 */

import os from "node:os";
import express from "express";
import { config, PRODUCT_NAME, DEVKIT_VERSION } from "./config.js";
import * as store from "./store.js";

export const api = express.Router();

api.use(express.json({ limit: "256kb" })); // matches the device-side contract

/* ---------- live channel plumbing (SSE) ---------- */

// deviceId -> Set<res> of open event streams
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

api.post("/api/ingest", (req, res) => {
  const auth = req.get("authorization") || "";
  if (auth !== `Bearer ${config.token}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // One frame object, or an array of frames (a device catching up after a
  // connectivity gap batches up to 50 per POST).
  const frames = Array.isArray(req.body) ? req.body : [req.body];
  if (frames.length > 50) {
    return res.status(400).json({ error: "too_many_frames" });
  }

  let accepted = 0;
  for (const frame of frames) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) continue;
    const dev = store.addFrame(frame);
    accepted++;
    broadcast(dev.id, {
      device_id: dev.id,
      ts: dev.last_seen,
      frame,
    });
  }
  if (!accepted) return res.status(400).json({ error: "no_valid_frames" });
  res.json({ ok: true, accepted });
});

/* ---------- query ---------- */

api.get("/api/devices", (_req, res) => {
  res.json({ devices: store.listDevices() });
});

api.get("/api/devices/:id/latest", (req, res) => {
  const out = store.latest(req.params.id);
  if (!out) return res.status(404).json({ error: "no_frames" });
  res.json(out);
});

api.get("/api/devices/:id/history", (req, res) => {
  res.json(
    store.history(req.params.id, {
      from: req.query.from,
      to: req.query.to,
      intervalS: req.query.interval,
    })
  );
});

api.get("/api/devices/:id/dtc", (req, res) => {
  res.json(store.dtcReport(req.params.id));
});

api.get("/api/devices/:id/live", (req, res) => {
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

api.get("/healthz", (_req, res) => {
  res.json({ ok: true, ...store.stats() });
});

// The console uses this to show real, copy-pasteable ingest URLs.
api.get("/api/meta", (_req, res) => {
  res.json({
    product: PRODUCT_NAME,
    kit: "DevKit",
    version: DEVKIT_VERSION,
    port: config.port,
    ingest_urls: ingestUrls(),
    ...store.stats(),
  });
});

/** Every URL a device on the same network could reach this kit at. */
export function ingestUrls() {
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
