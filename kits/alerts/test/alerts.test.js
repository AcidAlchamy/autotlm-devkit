/* AutoTLM DevKit — alerts kit test.
 *
 * No live kit needed: we fake the two endpoints alerts.js consumes with an
 * in-process node:http server — a /api/devices listing and an SSE stream
 * emitting three frames built from the canonical Core frame — plus two
 * capture endpoints standing in for a webhook and a Discord webhook. Then
 * we run the real alerts.js as a child process against it and assert on
 * what it delivered.
 *
 *   node --test kits/alerts/test/alerts.test.js
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 3821; // kits/alerts owns 3821–3839
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/* The telemetry frame exactly as AutoTLM Core's README documents it — the
 * same contract example the core kit's smoke test uses. We only mutate
 * coolant_c and dtc.codes per emission below. */
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

const mk = (coolant_c, codes) => ({
  ...CANONICAL_FRAME,
  obd: { ...CANONICAL_FRAME.obd, coolant_c },
  dtc: { mil: true, codes },
});

/* Three frames, ~80 ms apart:
 *   1. coolant 88, P0171          → nothing fires; seeds the dtc baseline
 *   2. coolant 110, P0171         → threshold (>105) fires
 *   3. coolant 112, P0171+P0300   → threshold held by cooldown; dtc fires
 */
const SEQUENCE = [mk(88, ["P0171"]), mk(110, ["P0171"]), mk(112, ["P0171", "P0300"])];

const hooks = [];    // JSON bodies POSTed to /hook
const discords = []; // JSON bodies POSTed to /discord
let server;
let child;
let childOut = "";
let tmpDir;
let sseServed = false;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

before(async () => {
  server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/devices") {
      const now = new Date().toISOString();
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          devices: [{ id: "A6445000", name: "A6445000", created_at: now, last_seen: now, vin: null }],
        })
      );
    }
    if (req.method === "GET" && req.url === "/api/devices/A6445000/live") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write("retry: 250\n\n");
      if (!sseServed) {
        sseServed = true; // emit once — a client reconnect must not replay
        SEQUENCE.forEach((frame, i) => {
          setTimeout(() => {
            try {
              const msg = { device_id: "A6445000", ts: new Date().toISOString(), frame };
              res.write(`data: ${JSON.stringify(msg)}\n\n`);
            } catch { /* client gone — the asserts will say so */ }
          }, 40 + i * 80);
        });
        // a keep-alive comment mid-sequence proves the parser skips them
        setTimeout(() => {
          try { res.write(": ping\n\n"); } catch { /* ditto */ }
        }, 80);
      }
      return; // leave the stream open
    }
    if (req.method === "POST" && req.url === "/hook") {
      try { hooks.push(JSON.parse(await readBody(req))); } catch { hooks.push({ bad: true }); }
      return res.end("{}");
    }
    if (req.method === "POST" && req.url === "/discord") {
      try { discords.push(JSON.parse(await readBody(req))); } catch { discords.push({ bad: true }); }
      res.statusCode = 204;
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devkit-alerts-"));
  const rulesFile = path.join(tmpDir, "rules.json");
  fs.writeFileSync(
    rulesFile,
    JSON.stringify([
      {
        path: "obd.coolant_c", op: ">", value: 105, for_s: 0, cooldown_s: 300,
        message: "Coolant {value}°C on {device}", webhook: `${BASE}/hook`,
      },
      {
        type: "dtc", cooldown_s: 0, message: "New trouble code: {codes}",
        webhook: `${BASE}/hook`, discord: `${BASE}/discord`,
      },
    ])
  );

  // no --device on purpose: the auto-pick path is under test too
  child = spawn(
    process.execPath,
    [path.join("kits", "alerts", "alerts.js"), "--base", BASE, "--rules", rulesFile],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.on("data", (c) => (childOut += c));
  child.stderr.on("data", (c) => (childOut += c));
});

after(() => {
  child?.kill();
  server?.closeAllConnections?.();
  server?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitFor(cond, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}\n--- alerts.js output ---\n${childOut}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("picks the most recently seen device when --device is omitted", async () => {
  await waitFor(() => childOut.includes("watching A6445000"), "the device auto-pick log line");
});

test("threshold rule fires with the documented webhook body shape", async () => {
  await waitFor(() => hooks.some((h) => h.rule !== "dtc"), "the threshold webhook");
  const hook = hooks.find((h) => h.rule !== "dtc");
  for (const key of ["device_id", "rule", "message", "value", "ts"]) {
    assert.ok(key in hook, `body has ${key}`);
  }
  assert.equal(hook.device_id, "A6445000");
  assert.equal(hook.rule, "obd.coolant_c > 105");
  assert.equal(hook.message, "Coolant 110°C on A6445000", "{value}/{device} interpolated");
  assert.equal(hook.value, 110);
  assert.ok(Number.isFinite(Date.parse(hook.ts)), "ts is a real timestamp");
});

test("dtc rule fires for the newly appeared code only", async () => {
  await waitFor(() => hooks.some((h) => h.rule === "dtc"), "the dtc webhook");
  const hook = hooks.find((h) => h.rule === "dtc");
  assert.equal(hook.message, "New trouble code: P0300", "the NEW code, not baseline P0171");
  assert.equal(hook.value, "P0300");
});

test("discord action posts the Discord-webhook shape", async () => {
  await waitFor(() => discords.length >= 1, "the discord POST");
  assert.deepEqual(discords[0], { content: "New trouble code: P0300" });
});

test("cooldown holds the threshold to a single fire across two crossings", async () => {
  // Frame 3 (also over 105) has been processed — the dtc webhook proved it.
  // Give any stray extra delivery a moment to land, then count.
  await waitFor(() => hooks.some((h) => h.rule === "dtc"), "frame 3 to be processed");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(hooks.filter((h) => h.rule !== "dtc").length, 1, "threshold fired exactly once");
  assert.equal(hooks.length, 2, "no surprise deliveries");
});
