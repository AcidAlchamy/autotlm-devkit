/* AutoTLM DevKit — replay: record a real drive once, replay it forever.
 *
 *   node kits/replay/replay.js --file data/telemetry.jsonl
 *
 * The DevKit family ships no fake data — so this tool generates none. It
 * replays a JSON-lines recording the kit itself made (DEVKIT_PERSIST=1),
 * re-POSTing your real frames one at a time and preserving the original
 * inter-frame gaps, so a fresh console plays your drive back at the cadence
 * it actually happened. No dependencies; plain `node replay.js`.
 */

import fs from "node:fs";
import { parseArgs } from "node:util";

// The product name lives in this ONE constant. Rebrand = edit this line.
const PRODUCT_NAME = "AutoTLM";

/* ---------- progress line + exits ---------- */

const t0 = Date.now();
let progressDirty = false;

function progress(loop, pass, n, total, ts) {
  // Only draw the \r overwrite line on a real terminal — a piped or logged
  // run gets the summary, not a wall of carriage returns.
  if (!process.stderr.isTTY) return;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const head = loop ? `pass ${pass} · ` : "";
  process.stderr.write(`\r  ${head}${n}/${total} · ${secs} s elapsed · ${ts}   `);
  progressDirty = true;
}

function endProgressLine() {
  if (progressDirty) {
    process.stderr.write("\n");
    progressDirty = false;
  }
}

function die(msg) {
  endProgressLine();
  console.error(`  ${msg}`);
  process.exit(1);
}

/* ---------- CLI ---------- */

const OPTIONS = {
  file: { type: "string" },
  target: { type: "string", default: "http://127.0.0.1:3000" },
  token: { type: "string", default: "devkit" },
  device: { type: "string" },
  speed: { type: "string", default: "1" },
  loop: { type: "boolean", default: false },
  // `--as-live` is an accepted alias for the default behavior. Live pacing is
  // the only honest replay mode: the alternative — batching the file up with
  // synthetic age_ms values — would claim these frames were captured during a
  // connectivity gap that never happened, fabricating a timeline. We don't.
  "as-live": { type: "boolean", default: false },
  help: { type: "boolean", default: false },
};

function usage(out) {
  out.write(`
  ${PRODUCT_NAME} DevKit — replay a recorded drive back through ingest

  Usage:
    node kits/replay/replay.js --file <recording.jsonl> [options]

  Options:
    --file <path>     JSONL recording made by DEVKIT_PERSIST=1 (required)
    --target <url>    Kit to replay into              (default http://127.0.0.1:3000)
    --token <token>   Ingest bearer token             (default devkit)
    --device <id>     Replay only this device's frames
    --speed <n>       Playback rate — 2 = twice as fast, 0.5 = half (default 1)
    --loop            Start over when the recording ends, until Ctrl-C
    --as-live         Alias for the default pacing (it's the only honest mode)
    --help            This text

  Make a recording first: DEVKIT_PERSIST=1 npm start, then drive your real
  gear. See kits/replay/README.md for the full story.
`);
}

let values;
try {
  ({ values } = parseArgs({ options: OPTIONS }));
} catch (err) {
  console.error(`  ${err.message}`);
  usage(process.stderr);
  process.exit(1);
}

if (values.help) {
  usage(process.stdout);
  process.exit(0);
}
if (!values.file) {
  console.error("  --file is required — point it at a DEVKIT_PERSIST recording.");
  usage(process.stderr);
  process.exit(1);
}

const target = String(values.target).replace(/\/+$/, "");
if (!/^https?:\/\//.test(target)) {
  die(`--target must be an http(s) URL, got "${values.target}"`);
}
const speed = Number(values.speed);
if (!Number.isFinite(speed) || speed <= 0) {
  die(`--speed must be a positive number, got "${values.speed}"`);
}

/* ---------- load the recording ---------- */

let raw;
try {
  raw = fs.readFileSync(values.file, "utf8");
} catch (err) {
  die(
    `cannot read ${values.file} (${err.code || err.message}) — recordings are ` +
      `made by the kit itself: DEVKIT_PERSIST=1 npm start (see kits/replay/README.md)`
  );
}

// One {ts, frame} object per line, exactly as the kit's persistence writes
// them. A torn last line after a crash is routine — skip it, the same
// tolerance the kit's own replay-on-boot applies.
let records = [];
let skipped = 0;
for (const line of raw.split("\n")) {
  const s = line.trim(); // trim also eats a stray \r on Windows-edited files
  if (!s) continue;
  try {
    const rec = JSON.parse(s);
    const valid =
      rec &&
      typeof rec === "object" &&
      typeof rec.ts === "string" &&
      !Number.isNaN(Date.parse(rec.ts)) &&
      rec.frame &&
      typeof rec.frame === "object" &&
      !Array.isArray(rec.frame);
    if (valid) records.push(rec);
    else skipped++;
  } catch {
    skipped++;
  }
}

if (values.device) {
  // The kit files frames without a device.id under a shared "UNKNOWN" device,
  // so the filter reckons identity the same way it does.
  records = records.filter(
    (r) => (r.frame?.device?.id || "UNKNOWN") === values.device
  );
}

if (!records.length) {
  die(
    `no frames to replay in ${values.file}` +
      (values.device ? ` for device "${values.device}"` : "") +
      (skipped ? ` (${skipped} unparseable line(s))` : "") +
      ` — is this a DEVKIT_PERSIST recording?`
  );
}

/* ---------- clean Ctrl-C ---------- */

let stopping = false;
let wake = null; // resolver of whichever inter-frame sleep is in progress

process.on("SIGINT", () => {
  if (stopping) process.exit(130); // second Ctrl-C: the user means NOW
  stopping = true; // first one: finish the in-flight POST, summarize, exit 0
  if (wake) wake();
});

// A sleep we can cut short — Ctrl-C during a long recorded gap shouldn't
// leave you waiting the gap out.
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(t);
      wake = null;
      resolve();
    };
  });
}

/* ---------- send one frame ---------- */

async function send(recordedFrame) {
  // Strip any recorded age_ms before re-posting. In the frame contract,
  // age_ms describes the ORIGINAL transport — "captured this long before the
  // device managed to send it". That was true of the drive we recorded, not
  // of this replay; forwarding it would backdate tonight's replay into last
  // week's timeline — exactly the fabricated history this family refuses to
  // ship. The receiving kit stamps each frame at arrival instead, and our
  // pacing makes those arrivals echo the recording's rhythm.
  const { age_ms, ...frame } = recordedFrame;
  void age_ms;

  let res;
  try {
    res = await fetch(`${target}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${values.token}`,
      },
      body: JSON.stringify(frame),
    });
  } catch (err) {
    die(
      `cannot reach ${target} (${err.cause?.code || err.message}) — is the ` +
        `kit running? (npm start in the repo root)`
    );
  }
  if (res.status === 401) {
    die(
      `ingest rejected the token (401) — check --token matches the kit's ` +
        `DEVKIT_TOKEN (default "devkit")`
    );
  }
  if (!res.ok) {
    die(`ingest answered HTTP ${res.status}: ${await res.text()}`);
  }
}

/* ---------- the replay loop ---------- */

console.error(
  `  ${PRODUCT_NAME} DevKit replay — ${records.length} frame(s) from ${values.file}` +
    (skipped ? ` (${skipped} unparseable line(s) skipped)` : "")
);
console.error(
  `  → ${target}/api/ingest · speed ×${speed}` +
    (values.loop ? " · looping (Ctrl-C to stop)" : "")
);

let sent = 0;
let pass = 0;
do {
  pass++;
  let posInPass = 0;
  let prevMs = null;
  for (const rec of records) {
    if (stopping) break;
    const capturedMs = Date.parse(rec.ts);
    if (prevMs != null) {
      // The recorded capture-time delta, scaled by --speed. A backdated
      // catch-up frame can sit AFTER a live one in the file with an OLDER
      // ts — clamp that negative delta to zero rather than time-traveling.
      const gap = Math.max(0, capturedMs - prevMs) / speed;
      if (gap > 0) await sleep(gap);
      if (stopping) break;
    }
    prevMs = capturedMs;
    await send(rec.frame);
    sent++;
    posInPass++;
    progress(values.loop, pass, posInPass, records.length, rec.ts);
  }
} while (values.loop && !stopping);

endProgressLine();
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.error(
  stopping
    ? `  stopped — ${sent} frame(s) sent in ${secs} s`
    : `  replay complete — ${sent} frame(s) → ${target} in ${secs} s`
);
