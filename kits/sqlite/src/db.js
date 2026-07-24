/* AutoTLM DevKit — SQLite kit: the durable telemetry store.
 *
 * Same function surface as the core kit's src/store.js — addFrame, listDevices,
 * latest, history, dtcReport, stats — but backed by a database file instead of
 * a ring buffer in RAM. Restart the process and everything is still here; that
 * is this kit's whole reason to exist.
 *
 * The database is node:sqlite, which ships inside Node itself (>= 22.5), so
 * the repo still depends on express and nothing else. It prints an
 * ExperimentalWarning at boot — the API surface we use is small and stable,
 * and the warning is honest, so we let it print.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Trim a device's oldest frames every this-many inserts, not every insert —
 *  a per-device count can briefly overshoot the cap by up to this much. */
const TRIM_EVERY = 100;

export function openDb(file, { bufferFrames = 50000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  // WAL journaling: readers never block the writer, and a crash mid-write
  // tears one transaction, never the file. synchronous=NORMAL is the standard
  // WAL pairing — durable to the last checkpoint, fast enough for a live
  // telemetry stream.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  // Three tables, one per concern the query API serves:
  //   devices — the roster (one row per device id, last-seen bookkeeping)
  //   frames  — every accepted frame, verbatim JSON, at its capture time
  //   dtc     — the trouble-code ledger (first/last seen + active, per code)
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      vin        TEXT,
      created_at TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      mil        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS frames (
      device_id  TEXT NOT NULL,
      ts         TEXT NOT NULL,
      frame_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS frames_device_ts ON frames (device_id, ts);
    CREATE TABLE IF NOT EXISTS dtc (
      device_id  TEXT NOT NULL,
      code       TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (device_id, code)
    );
  `);

  const stmts = {
    insDevice: db.prepare(
      `INSERT INTO devices (id, name, vin, created_at, last_seen, mil)
       VALUES (?, ?, NULL, ?, ?, 0)
       ON CONFLICT (id) DO NOTHING`
    ),
    // last_seen only moves forward — a backdated catch-up frame arriving
    // after a live one must not roll the device's "last seen" into the past.
    // ISO-8601 UTC strings sort like the times they name, so `<` is enough.
    touchDevice: db.prepare(
      `UPDATE devices SET last_seen = ? WHERE id = ? AND last_seen < ?`
    ),
    setVin: db.prepare(`UPDATE devices SET vin = ? WHERE id = ?`),
    setMil: db.prepare(`UPDATE devices SET mil = ? WHERE id = ?`),
    insFrame: db.prepare(
      `INSERT INTO frames (device_id, ts, frame_json) VALUES (?, ?, ?)`
    ),
    upsertDtc: db.prepare(
      `INSERT INTO dtc (device_id, code, first_seen, last_seen, active)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (device_id, code)
       DO UPDATE SET last_seen = excluded.last_seen, active = 1`
    ),
    // A frame that DOES carry a dtc object is authoritative about what's
    // currently stored in the car — codes missing from it have cleared.
    // The present codes arrive as a JSON array so one prepared statement
    // covers any count (json_each turns it into a selectable list).
    clearDtc: db.prepare(
      `UPDATE dtc SET active = 0
       WHERE device_id = ? AND code NOT IN (SELECT value FROM json_each(?))`
    ),
    // The ring-buffer equivalent: keep the newest `cap` frames per device,
    // delete the rest. LIMIT -1 OFFSET cap = "everything past the newest cap".
    trim: db.prepare(
      `DELETE FROM frames WHERE device_id = ? AND rowid IN (
         SELECT rowid FROM frames WHERE device_id = ?
         ORDER BY ts DESC LIMIT -1 OFFSET ?
       )`
    ),
    listDevices: db.prepare(
      `SELECT id, name, created_at, last_seen, vin
       FROM devices ORDER BY last_seen DESC`
    ),
    // "Latest" is the last frame that ARRIVED, not the newest capture time —
    // exactly the core kit's semantics (its ring buffer serves the last
    // push). rowid preserves arrival order, including across restarts.
    latest: db.prepare(
      `SELECT d.name AS name, f.ts AS ts, f.frame_json AS frame_json
       FROM frames f JOIN devices d ON d.id = f.device_id
       WHERE f.device_id = ? ORDER BY f.rowid DESC LIMIT 1`
    ),
    // History downsampling in SQL. The inner query computes each frame's
    // bucket index — capture time in ms (unixepoch(ts,'subsec') matches
    // JS Date.parse exactly) integer-divided by the interval, the same
    // arithmetic the core kit does in JS. The outer GROUP BY keeps one row
    // per bucket; with a lone MAX() aggregate SQLite serves the other
    // columns from the row that won it — i.e. newest capture wins the
    // bucket, so an old catch-up frame never overwrites a fresher point.
    // Newest `cap` buckets survive (DESC + LIMIT); we re-sort ascending in JS.
    history: db.prepare(
      `SELECT MAX(ts) AS ts, frame_json
       FROM (
         SELECT ts, frame_json,
                CAST(unixepoch(ts, 'subsec') * 1000 AS INTEGER) / ? AS bucket
         FROM frames
         WHERE device_id = ? AND ts >= ? AND ts <= ?
       )
       GROUP BY bucket
       ORDER BY bucket DESC
       LIMIT ?`
    ),
    getDeviceMil: db.prepare(`SELECT mil FROM devices WHERE id = ?`),
    dtcCodes: db.prepare(
      `SELECT code, first_seen, last_seen, active
       FROM dtc WHERE device_id = ?
       ORDER BY active DESC, first_seen, code`
    ),
    stats: db.prepare(
      `SELECT (SELECT COUNT(*) FROM devices) AS devices,
              (SELECT COUNT(*) FROM frames)  AS frames`
    ),
    allDeviceIds: db.prepare(`SELECT id FROM devices`),
  };

  // Inserts since the last trim, per device — process-local on purpose: worst
  // case after a restart a device is trimmed TRIM_EVERY inserts late, and the
  // boot-time sweep below already squared everything up.
  const insertsSinceTrim = new Map();

  function trim(id) {
    stmts.trim.run(id, id, bufferFrames);
  }

  // Sweep once at open so a lowered DEVKIT_BUFFER takes effect immediately
  // instead of waiting for each device's next hundred frames.
  for (const { id } of stmts.allDeviceIds.all()) trim(id);

  /* ---------- ingest side ---------- */

  /**
   * Accept one telemetry frame at capture time `ts` (the ingest route does
   * the age_ms subtraction, same as the core kit). Returns `{ id }` — the
   * device it landed in, which is all the API layer needs for its broadcast.
   */
  function addFrame(frame, ts = new Date().toISOString()) {
    // Frames without a device.id all merge into one "UNKNOWN" device rather
    // than being dropped — a half-written sketch beats silent data loss.
    const id = frame?.device?.id || "UNKNOWN";

    // One frame = one transaction: the roster, the frame and the DTC ledger
    // move together or not at all, and batching the writes is faster too.
    db.exec("BEGIN");
    try {
      stmts.insDevice.run(id, id, ts, ts);
      stmts.touchDevice.run(ts, id, ts);
      stmts.insFrame.run(id, ts, JSON.stringify(frame));

      // Sub-objects are OPTIONAL in the frame contract: absent means "no
      // data this cycle", never "the value is zero". Only update what's
      // present — and null-check inside the sub-objects too.
      if (frame?.obd?.vin) stmts.setVin.run(String(frame.obd.vin), id);

      if (frame?.dtc) {
        stmts.setMil.run(frame.dtc.mil ? 1 : 0, id);
        const present = [
          ...new Set(
            Array.isArray(frame.dtc.codes) ? frame.dtc.codes.map(String) : []
          ),
        ];
        for (const code of present) stmts.upsertDtc.run(id, code, ts, ts);
        stmts.clearDtc.run(id, JSON.stringify(present));
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    const n = (insertsSinceTrim.get(id) || 0) + 1;
    if (n >= TRIM_EVERY) {
      trim(id);
      insertsSinceTrim.set(id, 0);
    } else {
      insertsSinceTrim.set(id, n);
    }
    return { id };
  }

  /* ---------- query side ---------- */

  function listDevices() {
    return stmts.listDevices.all().map((d) => ({
      id: d.id,
      name: d.name,
      created_at: d.created_at,
      last_seen: d.last_seen,
      vin: d.vin,
    }));
  }

  function latest(id) {
    const row = stmts.latest.get(id);
    if (!row) return null;
    return {
      device_id: id,
      name: row.name,
      ts: row.ts,
      frame: JSON.parse(row.frame_json),
    };
  }

  /**
   * Time-range history, downsampled to one point per `intervalS` seconds
   * (newest capture in each bucket wins) — same shape and same bucket
   * arithmetic as the core kit, just computed by SQLite instead of a JS loop.
   */
  function history(id, { from, to, intervalS = 5, cap = 5000 } = {}) {
    const now = Date.now();
    const fromMs = from ? Date.parse(from) : now - 3600_000; // default: last hour
    const toMs = to ? Date.parse(to) : now;
    const stepMs = Math.max(1, Number(intervalS) || 5) * 1000;

    // The range filter compares ISO strings — fixed-width UTC timestamps
    // sort like the times they name, and a string range rides the
    // (device_id, ts) index.
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(toMs).toISOString();

    const points = stmts.history
      .all(stepMs, id, fromIso, toIso, cap)
      .reverse() // the query keeps the newest buckets; serve oldest-first
      .map((r) => ({ ts: r.ts, frame: JSON.parse(r.frame_json) }));

    return {
      device_id: id,
      from: fromIso,
      to: toIso,
      interval_s: stepMs / 1000,
      points,
    };
  }

  function dtcReport(id) {
    const dev = stmts.getDeviceMil.get(id);
    // SQLite stores booleans as 0/1 — serve real booleans, same as the core.
    const codes = stmts.dtcCodes.all(id).map((r) => ({
      code: r.code,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      active: !!r.active,
    }));
    return { device_id: id, mil: dev ? !!dev.mil : false, codes };
  }

  /**
   * frames_received here means "frames the store holds" — the durable
   * counterpart of the core kit's counter (which also resets to the stored
   * count when it replays its JSONL file). Trimmed frames leave the count.
   */
  function stats() {
    const row = stmts.stats.get();
    return { devices: row.devices, frames_received: row.frames };
  }

  function close() {
    db.close();
  }

  return { file, addFrame, listDevices, latest, history, dtcReport, stats, close };
}
