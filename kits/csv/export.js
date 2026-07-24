/* AutoTLM DevKit — history → spreadsheet.
 *
 * A zero-dependency exporter for the kit's /history endpoint: point it at a
 * running kit (or the cloud — same response shapes), pick a device, and your
 * drive comes back as CSV on stdout, ready for Excel, Sheets or pandas.
 *
 *   node kits/csv/export.js --device MYCAR > drive.csv
 *
 * Global fetch + the standard library only. No install, no dependencies —
 * this file runs on bare Node.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const USAGE = `Usage: node kits/csv/export.js --device <id> [options]

  --base <url>          kit or cloud base URL       (default http://127.0.0.1:3000)
  --device <id>         device to export            (required)
  --from <ISO>          range start                 (server default: one hour ago)
  --to <ISO>            range end                   (server default: now)
  --interval <seconds>  downsample bucket           (server default: 5)
  --out <file>          write to a file instead of stdout
  --format <csv|jsonl>  output format               (default: csv)
`;

/** Complain on stderr and exit nonzero — stdout stays clean for the data. */
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/* ---------- CLI ---------- */

function parseArgs(argv) {
  const args = { base: "http://127.0.0.1:3000", format: "csv" };
  const take = (i, name) => {
    if (argv[i] === undefined) fail(`${name} needs a value\n\n${USAGE}`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--base": args.base = take(++i, "--base"); break;
      case "--device": args.device = take(++i, "--device"); break;
      case "--from": args.from = take(++i, "--from"); break;
      case "--to": args.to = take(++i, "--to"); break;
      case "--interval": args.interval = take(++i, "--interval"); break;
      case "--out": args.out = take(++i, "--out"); break;
      case "--format": args.format = take(++i, "--format"); break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`unknown option: ${argv[i]}\n\n${USAGE}`);
    }
  }
  if (args.format !== "csv" && args.format !== "jsonl") {
    fail(`--format must be csv or jsonl, not "${args.format}"\n\n${USAGE}`);
  }
  args.base = args.base.replace(/\/+$/, ""); // tolerate a trailing slash
  return args;
}

/* ---------- fetching ---------- */

async function getJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    fail(`could not reach ${url} — is the kit running? (${e.cause?.code || e.message})`);
  }
  if (!res.ok) fail(`${url} answered HTTP ${res.status}`);
  return res.json();
}

/** A readable device roster for the "which device?" error messages. */
function deviceRoster(devices) {
  if (!devices.length) return "  (none yet — has anything pushed to this kit?)";
  return devices
    .map((d) => `  ${d.id}${d.vin ? `  vin ${d.vin}` : ""}  last seen ${d.last_seen}`)
    .join("\n");
}

/* ---------- flattening ---------- */

/** Cells hold scalars. Arrays and nested objects don't fit — jsonl keeps them. */
function isScalar(v) {
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean";
}

/**
 * One history point → { column: value }. Group prefixes keep columns from
 * colliding (obd and gps both carry a speed_kph). Every sub-object in the
 * frame is optional and so is every field inside one — we only emit what a
 * point actually carried; the header union fills the gaps with empty cells.
 */
function flatten(point, deviceId) {
  const row = { ts: point.ts, device_id: deviceId };
  const frame = point.frame || {};
  for (const group of ["obd", "gps", "imu"]) {
    const obj = frame[group];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    for (const [k, v] of Object.entries(obj)) {
      if (group === "obd" && k === "pids") continue; // PIDs get their own columns
      if (isScalar(v)) row[`${group}_${k}`] = v;
    }
  }
  if (frame.dtc && isScalar(frame.dtc.mil)) row.dtc_mil = frame.dtc.mil;
  const pids = frame.obd?.pids;
  if (pids && typeof pids === "object" && !Array.isArray(pids)) {
    for (const [k, v] of Object.entries(pids)) {
      if (isScalar(v)) row[`pid_${k}`] = v;
    }
  }
  return row;
}

/**
 * Header = the union of every column any point produced. A sensor that
 * showed up for one frame mid-drive still gets its column; rows without it
 * get an empty cell. Order is deterministic: the fixed pair first, then each
 * group sorted within itself — same input, same header, every time.
 */
function headerFor(rows) {
  const groups = { obd: new Set(), gps: new Set(), imu: new Set(), dtc: new Set(), pid: new Set() };
  for (const row of rows) {
    for (const col of Object.keys(row)) {
      const g = groups[col.slice(0, col.indexOf("_"))];
      if (g) g.add(col); // ts / device_id fall through — they're the fixed pair
    }
  }
  return [
    "ts",
    "device_id",
    ...[...groups.obd].sort(),
    ...[...groups.gps].sort(),
    ...[...groups.imu].sort(),
    ...[...groups.dtc].sort(),
    ...[...groups.pid].sort(), // 2-char uppercase-hex keys sort correctly as strings
  ];
}

/* ---------- output formats ---------- */

/**
 * RFC-4180 quoting: a field containing a comma, a double quote or a line
 * break gets wrapped in double quotes, with embedded quotes doubled.
 * Everything else passes through bare so spreadsheets parse numbers as
 * numbers. Absent → empty cell, never "null".
 */
function csvField(v) {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(points, deviceId) {
  const rows = points.map((p) => flatten(p, deviceId));
  const header = headerFor(rows);
  // pid_* column names are data-derived (obd.pids keys), so header cells get
  // the same RFC-4180 quoting as values — a hostile key can't skew the grid
  const lines = [header.map((c) => csvField(c)).join(",")];
  for (const row of rows) {
    lines.push(header.map((c) => csvField(row[c])).join(","));
  }
  return { text: lines.join("\n") + "\n", columns: header.length };
}

/**
 * jsonl: one {ts, frame} object per line, the frame verbatim — nothing
 * flattened, nothing dropped. This is the same line format the kit's own
 * DEVKIT_PERSIST flag writes, so an export is readable by anything built
 * against that (kits/replay included).
 */
function toJsonl(points) {
  const lines = points.map((p) => JSON.stringify({ ts: p.ts, frame: p.frame }));
  return { text: lines.length ? lines.join("\n") + "\n" : "", columns: null };
}

/* ---------- main ---------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Validate the device against /api/devices up front, so a missing or
  // typo'd id gets a roster of real ones instead of a silently empty file.
  const { devices } = await getJson(`${args.base}/api/devices`);
  if (!args.device) {
    fail(`--device is required. Devices this kit knows:\n${deviceRoster(devices)}\n\n${USAGE}`);
  }
  if (!devices.some((d) => d.id === args.device)) {
    fail(`unknown device "${args.device}". Devices this kit knows:\n${deviceRoster(devices)}`);
  }

  const qs = new URLSearchParams();
  if (args.from) qs.set("from", args.from);
  if (args.to) qs.set("to", args.to);
  if (args.interval) qs.set("interval", args.interval);
  const query = qs.toString();
  const hist = await getJson(
    `${args.base}/api/devices/${encodeURIComponent(args.device)}/history${query ? `?${query}` : ""}`
  );
  const points = hist.points || [];
  if (!points.length) {
    console.error(`0 points between ${hist.from} and ${hist.to} — widen --from/--to?`);
  }

  const { text, columns } = args.format === "jsonl" ? toJsonl(points) : toCsv(points, args.device);
  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), text);
  } else {
    process.stdout.write(text);
  }

  // The summary goes to stderr on purpose — piping stdout stays clean.
  console.error(
    `exported ${points.length} point(s)` +
      (columns === null ? "" : `, ${columns} columns`) +
      ` (${args.format}) → ${args.out || "stdout"}`
  );
}

main().catch((e) => fail(e.stack || String(e)));
