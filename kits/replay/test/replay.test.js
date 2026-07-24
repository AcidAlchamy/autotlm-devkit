/* AutoTLM DevKit — replay kit test.
 *
 * Builds a three-line JSONL fixture (the canonical Core frame, recorded at
 * three capture times), boots the REAL root server on a scratch port, runs
 * replay.js against it as a child process, and proves the three things the
 * kit promises: every frame lands, the recording's cadence is preserved
 * (scaled by --speed), and a recorded age_ms is stripped on the way through.
 *
 *   node --test kits/replay/test/
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3861; // kits/replay's assigned scratch range: 3861–3879
const TOKEN = "replay-token";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPLAY = path.join(ROOT, "kits", "replay", "replay.js");

/* The telemetry frame exactly as AutoTLM Core's README documents it — the
 * contract example, same as the root smoke test uses. */
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

/* A recording of three frames, 6 s apart at capture time. At --speed 10 the
 * replay's real gaps are 600 ms each — long enough to measure, short enough
 * to keep the test quick, and wide enough that the first and last arrival
 * are guaranteed to land in different 1-second history buckets. The last
 * frame carries a recorded age_ms (a device once sent it as catch-up) —
 * replay must strip it. */
const DEVICE = "A6445000";
const REC_T0 = Date.parse("2026-07-01T10:00:00.000Z");
const mkFrame = (rpm, extra = {}) => ({
  ...CANONICAL_FRAME,
  obd: { ...CANONICAL_FRAME.obd, rpm },
  ...extra,
});
const RECORDS = [
  { ts: new Date(REC_T0).toISOString(), frame: mkFrame(1500) },
  { ts: new Date(REC_T0 + 6_000).toISOString(), frame: mkFrame(2200) },
  { ts: new Date(REC_T0 + 12_000).toISOString(), frame: mkFrame(3100, { age_ms: 4200 }) },
];

let server;
let tmpDir;
let fixture;

/** Run replay.js as a child process, capture everything, time it. */
function runReplay(args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [REPLAY, ...args], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, ms: Date.now() - started })
    );
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devkit-replay-test-"));
  fixture = path.join(tmpDir, "telemetry.jsonl");
  fs.writeFileSync(fixture, RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n");

  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DEVKIT_TOKEN: TOKEN, DEVKIT_PERSIST: "" },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    // our child dying (usually EADDRINUSE) means any healthz answer would be
    // a stale server squatting the port — fail loud, never adopt it
    if (server.exitCode !== null) {
      throw new Error(`server exited before answering — is a stale process squatting port ${PORT}? Kill it and re-run.`);
    }
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not boot within 30 s");
    await new Promise((res) => setTimeout(res, 100));
  }
});

after(() => {
  server?.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("replays every frame at the recording's cadence, age_ms stripped", async () => {
  const r = await runReplay([
    "--file", fixture,
    "--target", BASE,
    "--token", TOKEN,
    "--speed", "10",
  ]);
  assert.equal(r.code, 0, `replay exited cleanly (stderr: ${r.stderr})`);

  // Cadence: two 6 s recorded gaps at speed 10 = two real 600 ms sleeps, so
  // the run cannot finish faster than ~1.2 s. Loose on the upper side — a
  // loaded CI box only ever makes sleeps longer.
  assert.ok(r.ms >= 1_100, `respected the scaled gaps (took ${r.ms} ms)`);
  assert.ok(r.ms < 20_000, `did not stall (took ${r.ms} ms)`);

  // All three landed.
  const health = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(health.frames_received, 3, "every recorded frame was ingested");

  // The paced arrivals spread across history buckets — arrival times echo
  // the recording's rhythm. First and last arrival are ≥1.2 s apart, so at
  // interval=1 they can never share a bucket.
  const url = `${BASE}/api/devices/${DEVICE}/history?interval=1`;
  const { points } = await (await fetch(url)).json();
  assert.ok(points.length >= 2, `arrivals spread across buckets (got ${points.length})`);
  const times = points.map((p) => Date.parse(p.ts));
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i - 1] < times[i], "history points are time-ordered");
  }

  // The last frame arrived verbatim MINUS its recorded age_ms — the age
  // described the original transport, not this replay.
  const latest = await (await fetch(`${BASE}/api/devices/${DEVICE}/latest`)).json();
  assert.ok(!("age_ms" in latest.frame), "recorded age_ms was stripped");
  const { age_ms, ...lastWithoutAge } = RECORDS[2].frame;
  void age_ms;
  assert.deepEqual(latest.frame, lastWithoutAge, "frame otherwise passes through untouched");
});

test("a wrong token exits nonzero with a helpful message", async () => {
  const r = await runReplay([
    "--file", fixture,
    "--target", BASE,
    "--token", "wrong-token",
  ]);
  assert.notEqual(r.code, 0, "auth failure is a nonzero exit");
  assert.match(r.stderr, /token/i, "the message points at the token");

  // Nothing extra was accepted.
  const health = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(health.frames_received, 3, "the rejected run ingested nothing");
});

test("a missing recording exits nonzero and points at persistence", async () => {
  const r = await runReplay([
    "--file", path.join(tmpDir, "no-such.jsonl"),
    "--target", BASE,
    "--token", TOKEN,
  ]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /DEVKIT_PERSIST/, "the message says how recordings are made");
});

test("a device filter that matches nothing exits nonzero, not silently", async () => {
  const r = await runReplay([
    "--file", fixture,
    "--target", BASE,
    "--token", TOKEN,
    "--device", "NOSUCHDEVICE",
  ]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no frames/i);
});
