/* AutoTLM DevKit — SQLite kit test.
 *
 * Walks the same loop the core kit's smoke test walks — reject a bad token,
 * ingest the canonical frame, read it back through every query endpoint —
 * and then proves the one thing this kit exists for: KILL the server, boot a
 * fresh process on the same database file, and the history is still there.
 *
 *   node --test kits/sqlite/test/     (or the repo-root `npm test`)
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3811; // from this kit's assigned scratch range (3801–3819)
const TOKEN = "sqlite-smoke-token";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// A scratch database in the OS temp dir — never the kit's real data/ file,
// and unique per run so parallel test files can't trip over each other.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "devkit-sqlite-test-"));
const DB_FILE = path.join(TMP, "telemetry.db");

/* The telemetry frame exactly as AutoTLM Core's README documents it — copied
 * from the core kit's test/smoke.test.js, which is the contract example. */
const CANONICAL_FRAME = {
  source: "device",
  device: { id: "A6445000", type: "one", mems: "MPU-6050", fw_gnss: "OK", rssi: -51, modules: 2 },
  obd: {
    connected: true, speed_kph: 58, rpm: 1840, coolant_c: 88, load_pct: 23,
    throttle_pct: 14, volts: 14.2, vin: "YV0EXAMPLE0000000",
    pids: { "04": 23, "05": 88, "0C": 1840, "0D": 58, "11": 14 },
  },
  dtc: { mil: true, codes: ["P0171"] },
  gps: {
    fix: true, lat: 36.114647, lng: -115.172813, alt_m: 610.0,
    speed_kph: 57.9, course: 271, sats: 12, hdop: 0.8,
  },
  imu: { ax: 0.02, ay: -0.11, az: 1.0, gx: 0.4, gy: -0.2, gz: 0.1 },
};

let server;

function boot() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join("kits", "sqlite", "server.js")],
      {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DEVKIT_TOKEN: TOKEN, DEVKIT_DB: DB_FILE },
        stdio: "ignore",
      }
    );
    const deadline = Date.now() + 30_000;
    (async function poll() {
      // our child dying (usually EADDRINUSE) means any healthz answer would
      // be a stale server squatting the port — fail loud, never adopt it
      if (child.exitCode !== null) {
        return reject(new Error(`server exited before answering — is a stale process squatting port ${PORT}? Kill it and re-run.`));
      }
      try {
        const r = await fetch(`${BASE}/healthz`);
        if (r.ok) return resolve(child);
      } catch { /* not up yet */ }
      if (Date.now() > deadline) return reject(new Error("server did not boot within 30 s"));
      setTimeout(poll, 100);
    })();
  });
}

/** Kill a child and WAIT for it to die — the restart test reuses the port
 *  and the database file, so a half-dead process would poison both. */
function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill();
  });
}

function post(body, token = TOKEN) {
  return fetch(`${BASE}/api/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  server = await boot();
});

after(async () => {
  await stop(server);
  // WAL leaves -wal/-shm siblings next to the db; Windows can be slow to
  // release them, so let rmSync retry rather than failing the whole run.
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/* ---------- the standard loop, same as the core kit ---------- */

test("rejects a wrong ingest token with 401", async () => {
  const r = await post(CANONICAL_FRAME, "wrong-token");
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "unauthorized" });
});

test("accepts the canonical Core frame", async () => {
  const r = await post(CANONICAL_FRAME);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, accepted: 1 });
});

test("rejects a batch of more than 50 frames", async () => {
  const r = await post(Array.from({ length: 51 }, () => CANONICAL_FRAME));
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "too_many_frames" });
});

test("GET /api/devices lists the device with its VIN", async () => {
  const { devices } = await (await fetch(`${BASE}/api/devices`)).json();
  const dev = devices.find((d) => d.id === "A6445000");
  assert.ok(dev, "ingested device is listed");
  assert.equal(dev.vin, "YV0EXAMPLE0000000");
  for (const key of ["id", "name", "created_at", "last_seen", "vin"]) {
    assert.ok(key in dev, `device has ${key}`);
  }
});

test("GET /latest returns the frame verbatim", async () => {
  const r = await fetch(`${BASE}/api/devices/A6445000/latest`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.device_id, "A6445000");
  assert.ok(body.ts, "has a timestamp");
  assert.deepEqual(body.frame, CANONICAL_FRAME, "frame survives the JSON round-trip untouched");
});

test("GET /latest is a 404 for a device that never pushed", async () => {
  const r = await fetch(`${BASE}/api/devices/NOSUCHDEVICE/latest`);
  assert.equal(r.status, 404);
});

test("GET /dtc decodes the ledger with the code active", async () => {
  const body = await (await fetch(`${BASE}/api/devices/A6445000/dtc`)).json();
  assert.equal(body.mil, true);
  const code = body.codes.find((c) => c.code === "P0171");
  assert.ok(code, "P0171 is on the ledger");
  assert.equal(code.active, true);
  assert.ok(code.first_seen && code.last_seen);
});

test("batched catch-up frames spread across history via age_ms", async () => {
  // Three frames from one offline gap: captured 10 s ago, 5 s ago and now.
  // Oldest first with strictly decreasing age, exactly as Core batches them.
  const mk = (age_ms) => ({
    ...CANONICAL_FRAME,
    device: { ...CANONICAL_FRAME.device, id: "SQLBATCH1" },
    ...(age_ms != null ? { age_ms } : {}),
  });
  const r = await post([mk(10_000), mk(5_000), mk()]);
  assert.deepEqual(await r.json(), { ok: true, accepted: 3 });

  const url = `${BASE}/api/devices/SQLBATCH1/history?interval=1`;
  const { points } = await (await fetch(url)).json();
  assert.equal(points.length, 3, "one point per capture time, not one clump");
  const times = points.map((p) => Date.parse(p.ts));
  assert.ok(times[0] < times[1] && times[1] < times[2], "points are time-ordered");
  assert.ok(times[2] - times[0] >= 9_000, "the 10 s spread survived the batch");
});

test("a garbage age_ms cannot backdate history", async () => {
  const frame = {
    ...CANONICAL_FRAME,
    device: { ...CANONICAL_FRAME.device, id: "SQLGARBAGE" },
    age_ms: 999_999_999_999, // ~31 years — over the 7-day guard, treated as absent
  };
  await post(frame);
  const { ts } = await (await fetch(`${BASE}/api/devices/SQLGARBAGE/latest`)).json();
  assert.ok(Math.abs(Date.now() - Date.parse(ts)) < 5_000, "stamped at arrival instead");
});

/* ---------- the selling point ---------- */

test("history survives a full server restart", async () => {
  // Kill the process — not a graceful drain, an actual kill. WAL means the
  // database shrugs it off. Then boot a brand-new process on the same file.
  await stop(server);
  server = await boot();

  // Everything the first process ingested is still served.
  const latest = await (await fetch(`${BASE}/api/devices/A6445000/latest`)).json();
  assert.deepEqual(latest.frame, CANONICAL_FRAME, "the frame outlived the process");

  const { devices } = await (await fetch(`${BASE}/api/devices`)).json();
  const ids = devices.map((d) => d.id);
  for (const id of ["A6445000", "SQLBATCH1", "SQLGARBAGE"]) {
    assert.ok(ids.includes(id), `${id} is still on the roster`);
  }

  const dtc = await (await fetch(`${BASE}/api/devices/A6445000/dtc`)).json();
  assert.ok(dtc.codes.find((c) => c.code === "P0171"), "the DTC ledger survived too");

  // And the reopened database still accepts writes.
  const r = await post(CANONICAL_FRAME);
  assert.deepEqual(await r.json(), { ok: true, accepted: 1 });
});

test("GET /healthz reports durable totals", async () => {
  const body = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(body.ok, true);
  assert.ok(body.devices >= 3, "all test devices counted — across the restart");
  assert.ok(body.frames_received >= 6, "all stored frames counted — across the restart");
});
