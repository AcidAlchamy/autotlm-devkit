/* AutoTLM DevKit — built-in drive simulator.
 *
 * A fake car for your desk: pushes contract-correct telemetry frames at the
 * DevKit's ingest endpoint so the console lights up before any hardware is
 * connected. It drives a repeating loop — warm-up idle, city stop-and-go,
 * a highway stretch — warms the coolant, throws a lean-mixture fault partway
 * in, occasionally loses GPS fix (sub-objects are OMITTED when absent, and
 * your consumers should null-check; this makes sure you do).
 *
 *   npm run simulate
 *   node simulate.js --url http://127.0.0.1:3000/api/ingest --token devkit --id SIMCAR01 --hz 1
 */

const PRODUCT_NAME = "AutoTLM"; // rebrand = edit this line

/* ---------- args ---------- */
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
const URL_ = args.url || `http://127.0.0.1:${process.env.PORT || 3000}/api/ingest`;
const TOKEN = args.token || process.env.DEVKIT_TOKEN || "devkit";
const DEVICE_ID = args.id || "SIMCAR01";
const HZ = Math.max(0.2, Math.min(10, Number(args.hz) || 1));

/* ---------- the drive model ---------- */
// phase schedule (seconds): a ~6 min loop
const PHASES = [
  { name: "idle", until: 20 },
  { name: "city", until: 170 },
  { name: "highway", until: 300 },
  { name: "cooldown", until: 340 },
];
const LOOP_S = PHASES[PHASES.length - 1].until;

// route: an oval circuit; one lap ≈ 4 km, centered on a demo point
const ROUTE_CENTER = { lat: 36.1147, lng: -115.1728 };

let t = 0; // seconds since start
let speed = 0; // km/h
let coolant = 21; // °C — cold start
let fuel = 84; // %
let odometerKm = 0;
let lastSpeed = 0;
let sent = 0;

function phase() {
  const m = t % LOOP_S;
  return PHASES.find((p) => m < p.until).name;
}

function targetSpeed() {
  switch (phase()) {
    case "idle":
      return 0;
    case "city": {
      // stop-and-go: a traffic light every ~25 s
      return (t % 25) < 18 ? 45 + 10 * Math.sin(t / 3) : 0;
    }
    case "highway":
      return 105 + 8 * Math.sin(t / 17);
    default:
      return 0;
  }
}

function step(dt) {
  lastSpeed = speed;
  const target = targetSpeed();
  // approach the target speed with realistic accel (+8) / braking (-12) limits
  speed = Math.max(0, speed + Math.max(-12 * dt, Math.min(8 * dt, target - speed)));
  odometerKm += (speed / 3600) * dt;

  // coolant: warms toward 90, runs hotter on the highway
  const targetCoolant = phase() === "highway" ? 96 : 90;
  coolant += (targetCoolant - coolant) * 0.01 * dt * (speed > 0 ? 2 : 1);

  fuel = Math.max(3, fuel - speed * dt * 0.00008);
  t += dt;
}

function buildFrame() {
  const rpm =
    speed < 1 ? Math.round(830 + 40 * Math.sin(t)) : Math.round(900 + speed * 34);
  const throttle =
    speed < 1 ? 0 : Math.max(0, Math.min(100, Math.round((speed - lastSpeed) * 22 + speed * 0.35)));
  const load = Math.max(4, Math.min(96, Math.round(throttle * 0.7 + 12)));
  const volts = +(13.9 + 0.4 * Math.sin(t / 9) + (speed > 1 ? 0.2 : 0)).toFixed(1);

  // the fault story: P0171 (lean, bank 1) sets 75 s into every loop
  const milOn = (t % LOOP_S) > 75;

  const frame = {
    source: "device",
    device: {
      id: DEVICE_ID,
      type: "one",
      fw: `sim-${PRODUCT_NAME.toLowerCase()}-0.1`,
      rssi: Math.round(-48 - 6 * Math.abs(Math.sin(t / 40))),
      modules: 1,
    },
    obd: {
      connected: true,
      speed_kph: Math.round(speed),
      rpm,
      coolant_c: Math.round(coolant),
      load_pct: load,
      throttle_pct: throttle,
      volts,
      vin: "DEVK1TSIMULATED01",
      pids: {
        "04": load,
        "05": Math.round(coolant),
        "0C": rpm,
        "0D": Math.round(speed),
        "11": throttle,
        "2F": Math.round(fuel),
      },
    },
    dtc: { mil: milOn, codes: milOn ? ["P0171"] : [] },
    imu: {
      ax: +(((speed - lastSpeed) / 12.7)).toFixed(2), // longitudinal g
      ay: +(0.18 * Math.sin(t / 5) * (speed > 30 ? 1 : 0)).toFixed(2),
      az: +(1 + 0.02 * Math.sin(t * 2)).toFixed(2),
      gx: +(0.4 * Math.sin(t / 3)).toFixed(1),
      gy: +(0.3 * Math.cos(t / 4)).toFixed(1),
      gz: +(0.2 * Math.sin(t / 6)).toFixed(1),
    },
  };

  // GPS drops out for ~10 s every couple of minutes. When there's no fix the
  // gps object is OMITTED — that's the frame contract, not laziness.
  const gpsDropout = (t % 140) > 130;
  if (!gpsDropout) {
    const angle = (odometerKm / 4) * 2 * Math.PI; // one lap ≈ 4 km
    frame.gps = {
      fix: true,
      lat: +(ROUTE_CENTER.lat + 0.009 * Math.sin(angle)).toFixed(6),
      lng: +(ROUTE_CENTER.lng + 0.011 * Math.cos(angle)).toFixed(6),
      alt_m: +(610 + 6 * Math.sin(angle * 3)).toFixed(1),
      speed_kph: +speed.toFixed(1),
      course: Math.round(((angle * 180) / Math.PI + 90) % 360),
      sats: 9 + Math.round(2 * Math.abs(Math.sin(t / 30))),
      hdop: +(0.7 + 0.3 * Math.abs(Math.sin(t / 50))).toFixed(1),
    };
  }

  return frame;
}

/* ---------- push loop ---------- */

async function push(body) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return res.status;
}

console.log(`${PRODUCT_NAME} DevKit simulator → ${URL_}  (device ${DEVICE_ID}, ${HZ}/s, Ctrl-C to stop)`);

let backlog = []; // frames captured "offline", flushed as one batch
setInterval(async () => {
  step(1 / HZ);
  const frame = buildFrame();

  // every ~2 min, simulate a connectivity gap: hold 3 frames, then batch them
  const gap = (t % 120) > 114;
  if (gap && backlog.length < 3) {
    backlog.push(frame);
    return;
  }

  try {
    let status;
    if (backlog.length) {
      backlog.push(frame);
      status = await push(backlog); // array = batched catch-up POST
      console.log(`t=${Math.round(t)}s  ${phase().padEnd(8)} batch x${backlog.length}  → HTTP ${status}`);
      backlog = [];
    } else {
      status = await push(frame);
      sent++;
      if (sent % 10 === 1) {
        console.log(
          `t=${Math.round(t)}s  ${phase().padEnd(8)} ${String(Math.round(speed)).padStart(3)} km/h  ` +
          `${String(frame.obd.rpm).padStart(4)} rpm  ${Math.round(coolant)}°C  ` +
          `${frame.dtc.mil ? "MIL+P0171" : "no faults"}  → HTTP ${status}`
        );
      }
    }
  } catch (e) {
    console.log(`t=${Math.round(t)}s  push failed: ${e.message} — is the DevKit running?`);
  }
}, 1000 / HZ);
