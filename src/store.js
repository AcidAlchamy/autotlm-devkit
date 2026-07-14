/* AutoTLM DevKit — the in-memory telemetry store.
 *
 * One ring buffer of frames per device, plus the little bit of bookkeeping
 * the query API serves back: last-seen, VIN, and a trouble-code ledger with
 * first-seen / last-seen / active per code.
 *
 * This is deliberately NOT a database. It keeps the kit dependency-free and
 * instant to boot, and it makes the whole storage layer readable in one file.
 * Swapping this for SQLite or Postgres is the natural first upgrade — the
 * rest of the kit only talks to the functions exported here.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * devices: Map<deviceId, {
 *   id, name, vin, created_at, last_seen,
 *   frames: [{ ts, frame }],            // ring buffer, oldest first
 *   mil: boolean,
 *   dtc: Map<code, { first_seen, last_seen, active }>
 * }>
 */
const devices = new Map();

let framesReceived = 0;
let persistStream = null;

/* ---------- ingest side ---------- */

/**
 * Accept one telemetry frame. Returns the device record it landed in.
 * `ts` is stamped server-side — devices don't carry a clock we trust.
 */
export function addFrame(frame, ts = new Date().toISOString()) {
  const id = frame?.device?.id || "UNKNOWN";
  let dev = devices.get(id);
  if (!dev) {
    dev = {
      id,
      name: id,
      vin: null,
      created_at: ts,
      last_seen: ts,
      frames: [],
      mil: false,
      dtc: new Map(),
    };
    devices.set(id, dev);
  }

  dev.last_seen = ts;
  dev.frames.push({ ts, frame });
  if (dev.frames.length > config.bufferFrames) dev.frames.shift();
  framesReceived++;

  // Sub-objects are OPTIONAL in the frame contract: absent means "no data
  // this cycle", never "the value is zero". Only update what's present.
  if (frame?.obd?.vin) dev.vin = frame.obd.vin;

  if (frame?.dtc) {
    dev.mil = !!frame.dtc.mil;
    const present = new Set(
      Array.isArray(frame.dtc.codes) ? frame.dtc.codes.map(String) : []
    );
    for (const code of present) {
      const entry = dev.dtc.get(code);
      if (entry) {
        entry.last_seen = ts;
        entry.active = true;
      } else {
        dev.dtc.set(code, { first_seen: ts, last_seen: ts, active: true });
      }
    }
    // A frame that DOES carry a dtc object is authoritative about what's
    // currently stored in the car — codes missing from it have cleared.
    for (const [code, entry] of dev.dtc) {
      if (!present.has(code)) entry.active = false;
    }
  }

  if (persistStream) persistStream.write(JSON.stringify({ ts, frame }) + "\n");
  return dev;
}

/* ---------- query side ---------- */

export function listDevices() {
  return [...devices.values()]
    .sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1))
    .map((d) => ({
      id: d.id,
      name: d.name,
      created_at: d.created_at,
      last_seen: d.last_seen,
      vin: d.vin,
    }));
}

export function getDevice(id) {
  return devices.get(id) || null;
}

export function latest(id) {
  const dev = devices.get(id);
  if (!dev || !dev.frames.length) return null;
  const p = dev.frames[dev.frames.length - 1];
  return { device_id: dev.id, name: dev.name, ts: p.ts, frame: p.frame };
}

/**
 * Time-range history, downsampled to one point per `intervalS` seconds
 * (newest frame in each bucket wins). Same shape the cloud serves, so
 * chart code written against the DevKit ports over unchanged.
 */
export function history(id, { from, to, intervalS = 5, cap = 5000 } = {}) {
  const dev = devices.get(id);
  const now = Date.now();
  const fromMs = from ? Date.parse(from) : now - 3600_000; // default: last hour
  const toMs = to ? Date.parse(to) : now;
  const step = Math.max(1, Number(intervalS) || 5) * 1000;

  const buckets = new Map(); // bucketIndex -> point (newest wins)
  if (dev) {
    for (const p of dev.frames) {
      const t = Date.parse(p.ts);
      if (t < fromMs || t > toMs) continue;
      buckets.set(Math.floor(t / step), p);
    }
  }
  let points = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, p]) => p);
  if (points.length > cap) points = points.slice(points.length - cap);

  return {
    device_id: id,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    interval_s: step / 1000,
    points,
  };
}

export function dtcReport(id) {
  const dev = devices.get(id);
  const codes = dev
    ? [...dev.dtc.entries()].map(([code, e]) => ({ code, ...e }))
    : [];
  codes.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  return { device_id: id, mil: dev ? dev.mil : false, codes };
}

export function stats() {
  return { devices: devices.size, frames_received: framesReceived };
}

/* ---------- optional JSON-lines persistence ---------- */

export function initPersistence() {
  if (!config.persist) return;
  const file = path.resolve(config.persistFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Replay what we saved last time (ring-buffer caps still apply).
  if (fs.existsSync(file)) {
    let replayed = 0;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const { ts, frame } = JSON.parse(line);
        addFrame(frame, ts);
        replayed++;
      } catch {
        /* a torn last line after a crash is fine — skip it */
      }
    }
    framesReceived = replayed; // replay shouldn't double-count
    console.log(`  persistence: replayed ${replayed} frames from ${file}`);
  }
  persistStream = fs.createWriteStream(file, { flags: "a" });
}
