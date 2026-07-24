/* AutoTLM DevKit — kits/csv test.
 *
 * Boots the ROOT kit on a scratch port, ingests three canonical-frame
 * variants (different rpm, one carrying a PID the others lack, one with a
 * comma buried in a string field), then runs the exporter the same way a
 * user does — as a child process — and checks the CSV and JSONL that come
 * out. The test parses CSV lines with its own tiny RFC-4180 reader, so the
 * writer is checked by an independent implementation, not by itself.
 *
 *   node --test kits/csv/test/csv.test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3841; // kits/csv scratch range: 3841–3859
const TOKEN = "csv-kit-token";
const BASE = `http://127.0.0.1:${PORT}`;
const DEVICE = "CSVCAR1";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXPORT = path.join(ROOT, "kits", "csv", "export.js");

/* The telemetry frame exactly as AutoTLM Core's README documents it — the
 * contract this kit exists to receive. Same fixture as the root smoke test. */
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

/* Three points of one short drive, batched with decreasing age_ms so their
 * capture times spread 5 s apart and land in separate history buckets. */
function makeFrame({ rpm, extraPids, vin, age_ms }) {
  const f = structuredClone(CANONICAL_FRAME);
  f.device.id = DEVICE;
  f.obd.rpm = rpm;
  if (vin) f.obd.vin = vin;
  if (extraPids) Object.assign(f.obd.pids, extraPids);
  if (age_ms != null) f.age_ms = age_ms;
  return f;
}
const FRAMES = [
  makeFrame({ rpm: 1840, age_ms: 10_000 }),
  makeFrame({ rpm: 2200, extraPids: { "2F": 61 }, age_ms: 5_000 }), // the PID the others lack
  makeFrame({ rpm: 2600, vin: "YV0EXAMPLE,COMMA0" }), // the comma that must get quoted
];

/* The header the union must produce: fixed pair, then each group sorted.
 * Asserted as an exact string — order is part of the contract. */
const EXPECTED_HEADER = [
  "ts", "device_id",
  "obd_connected", "obd_coolant_c", "obd_load_pct", "obd_rpm",
  "obd_speed_kph", "obd_throttle_pct", "obd_vin", "obd_volts",
  "gps_alt_m", "gps_course", "gps_fix", "gps_hdop",
  "gps_lat", "gps_lng", "gps_sats", "gps_speed_kph",
  "imu_ax", "imu_ay", "imu_az", "imu_gx", "imu_gy", "imu_gz",
  "dtc_mil",
  "pid_04", "pid_05", "pid_0C", "pid_0D", "pid_11", "pid_2F",
].join(",");

/** A minimal RFC-4180 line reader — deliberately not the exporter's code. */
function parseCsvLine(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { fields.push(cur); cur = ""; }
    else cur += ch;
  }
  fields.push(cur);
  return fields;
}

function runExport(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [EXPORT, ...args], { cwd: ROOT });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

let server;
let tmpDir;

before(async () => {
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
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not boot within 30 s");
    await new Promise((res) => setTimeout(res, 100));
  }

  const r = await fetch(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(FRAMES),
  });
  assert.deepEqual(await r.json(), { ok: true, accepted: 3 });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devkit-csv-test-"));
});

after(() => {
  server?.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("csv: header is the exact sorted union across all points", async () => {
  const { code, out, err } = await runExport(["--base", BASE, "--device", DEVICE, "--interval", "1"]);
  assert.equal(code, 0, err);
  const lines = out.trimEnd().split("\n");
  assert.equal(lines[0], EXPECTED_HEADER);
  assert.equal(lines.length, 4, "header + one row per point");
});

test("csv: rows are time-ordered with values in the right columns", async () => {
  const { code, out, err } = await runExport(["--base", BASE, "--device", DEVICE, "--interval", "1"]);
  assert.equal(code, 0, err);
  const lines = out.trimEnd().split("\n");
  const header = lines[0].split(",");
  const rows = lines.slice(1).map(parseCsvLine);
  const col = (name) => header.indexOf(name);

  for (const row of rows) {
    assert.equal(row.length, header.length, "every row is as wide as the header");
    assert.equal(row[col("device_id")], DEVICE);
  }
  const times = rows.map((r) => Date.parse(r[col("ts")]));
  assert.ok(times[0] < times[1] && times[1] < times[2], "rows are time-ordered");
  assert.ok(times[2] - times[0] >= 9_000, "the age_ms spread survived into the export");
  assert.deepEqual(rows.map((r) => r[col("obd_rpm")]), ["1840", "2200", "2600"]);
});

test("csv: a PID one frame carried gets a column, others get empty cells", async () => {
  const { out } = await runExport(["--base", BASE, "--device", DEVICE, "--interval", "1"]);
  const lines = out.trimEnd().split("\n");
  const idx = lines[0].split(",").indexOf("pid_2F");
  assert.ok(idx >= 0, "the union header grew a pid_2F column");
  const rows = lines.slice(1).map(parseCsvLine);
  assert.deepEqual(rows.map((r) => r[idx]), ["", "61", ""]);
});

test("csv: a value containing a comma is RFC-4180 quoted", async () => {
  const { out } = await runExport(["--base", BASE, "--device", DEVICE, "--interval", "1"]);
  assert.ok(out.includes('"YV0EXAMPLE,COMMA0"'), "quoted on the wire");
  const lines = out.trimEnd().split("\n");
  const idx = lines[0].split(",").indexOf("obd_vin");
  const rows = lines.slice(1).map(parseCsvLine);
  assert.equal(rows[2][idx], "YV0EXAMPLE,COMMA0", "and it parses back intact");
});

test("jsonl: frames round-trip verbatim, one {ts, frame} per line", async () => {
  const { code, out, err } = await runExport([
    "--base", BASE, "--device", DEVICE, "--interval", "1", "--format", "jsonl",
  ]);
  assert.equal(code, 0, err);
  const lines = out.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  const parsed = lines.map((l) => JSON.parse(l));
  for (const p of parsed) {
    assert.ok(p.ts && p.frame, "each line is a {ts, frame} pair");
  }
  // Verbatim means verbatim: the frames come back exactly as posted,
  // age_ms and all (the server stores frames untouched).
  assert.deepEqual(parsed.map((p) => p.frame), FRAMES);
});

test("--out writes the same CSV to a file", async () => {
  const outFile = path.join(tmpDir, "drive.csv");
  const { code, err } = await runExport([
    "--base", BASE, "--device", DEVICE, "--interval", "1", "--out", outFile,
  ]);
  assert.equal(code, 0, err);
  const text = fs.readFileSync(outFile, "utf8");
  assert.equal(text.split("\n")[0], EXPECTED_HEADER);
});

test("omitting --device exits 1 and lists the devices it knows", async () => {
  const { code, out, err } = await runExport(["--base", BASE]);
  assert.equal(code, 1);
  assert.equal(out, "", "nothing lands on stdout on failure");
  assert.ok(err.includes("--device is required"));
  assert.ok(err.includes(DEVICE), "the roster names the real device");
});

test("an unknown --device exits 1 and lists the devices it knows", async () => {
  const { code, out, err } = await runExport(["--base", BASE, "--device", "NOSUCHCAR"]);
  assert.equal(code, 1);
  assert.equal(out, "", "nothing lands on stdout on failure");
  assert.ok(err.includes("NOSUCHCAR"));
  assert.ok(err.includes(DEVICE), "the roster names the real device");
});
