/* AutoTLM DevKit — smoke test.
 *
 * Boots the real server on a scratch port and walks the whole loop a device
 * walks: reject a bad token, ingest the canonical frame from AutoTLM Core's
 * README, then read it back through every query endpoint. No test framework,
 * no mocks — node:test, node:assert and fetch, all built in.
 *
 *   npm test
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3777;
const TOKEN = "smoke-token";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/* The telemetry frame exactly as AutoTLM Core's README documents it — the
 * contract this kit exists to receive. If this test breaks, either the kit
 * regressed or the contract moved; check Core's README before "fixing" it. */
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
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DEVKIT_TOKEN: TOKEN, DEVKIT_PERSIST: "" },
    stdio: "ignore",
  });
  // wait for the kit to answer — a cold npm-installed clone boots in well under a second
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not boot within 10 s");
    await new Promise((res) => setTimeout(res, 100));
  }
});

after(() => server?.kill());

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
  assert.deepEqual(body.frame, CANONICAL_FRAME, "frame is stored untouched");
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
    device: { ...CANONICAL_FRAME.device, id: "SMOKEBATCH1" },
    ...(age_ms != null ? { age_ms } : {}),
  });
  const r = await post([mk(10_000), mk(5_000), mk()]);
  assert.deepEqual(await r.json(), { ok: true, accepted: 3 });

  const url = `${BASE}/api/devices/SMOKEBATCH1/history?interval=1`;
  const { points } = await (await fetch(url)).json();
  assert.equal(points.length, 3, "one point per capture time, not one clump");
  const times = points.map((p) => Date.parse(p.ts));
  assert.ok(times[0] < times[1] && times[1] < times[2], "points are time-ordered");
  assert.ok(times[2] - times[0] >= 9_000, "the 10 s spread survived the batch");
});

test("a garbage age_ms cannot backdate history", async () => {
  const frame = {
    ...CANONICAL_FRAME,
    device: { ...CANONICAL_FRAME.device, id: "SMOKEGARBAGE" },
    age_ms: 999_999_999_999, // ~31 years — over the 7-day guard, treated as absent
  };
  await post(frame);
  const { ts } = await (await fetch(`${BASE}/api/devices/SMOKEGARBAGE/latest`)).json();
  assert.ok(Math.abs(Date.now() - Date.parse(ts)) < 5_000, "stamped at arrival instead");
});

test("GET /healthz reports the totals", async () => {
  const body = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(body.ok, true);
  assert.ok(body.devices >= 3, "all test devices counted");
  assert.ok(body.frames_received >= 5, "all accepted frames counted");
});
