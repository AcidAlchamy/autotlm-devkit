/* AutoTLM DevKit — alerts: watch the stream, act on it.
 *
 *   node kits/alerts/alerts.js --base http://127.0.0.1:3000 [--device <id>] [--rules <file>]
 *
 * A standalone consumer of the live channel every kit serves (and AutoTLM
 * Cloud mirrors): subscribe to GET /api/devices/:id/live, evaluate a small
 * JSON rules file against every frame as it lands, and act — a console line
 * always, a webhook POST and/or a Discord message when a rule asks for one.
 *
 * Zero dependencies, on purpose. Node ships no EventSource, and that turns
 * out to be a feature here: the SSE client in `subscribe` below is the whole
 * wire protocol in about forty commented lines. If you've only ever consumed
 * SSE through a library, start there — there's less to it than you think.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The product name lives in this ONE constant. Rebrand = edit this line.
const PRODUCT_NAME = "AutoTLM";

/* ---------- CLI ---------- */

function usage(problem) {
  if (problem) console.error(`[alerts] ${problem}\n`);
  console.error(
    `usage: node kits/alerts/alerts.js [--base <url>] [--device <id>] [--rules <file>]

  --base    kit or cloud base URL          (default http://127.0.0.1:3000)
  --device  device id to watch             (default: the most recently seen)
  --rules   rules file, a JSON array       (default kits/alerts/rules.json —
                                            start from rules.example.json)`
  );
  process.exit(problem ? 1 : 0);
}

function parseCli(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let value;
    const eq = flag.indexOf("=");
    if (eq > 0) {
      value = flag.slice(eq + 1); // --flag=value works too
      flag = flag.slice(0, eq);
    }
    if (flag === "-h" || flag === "--help") usage();
    if (flag !== "--base" && flag !== "--device" && flag !== "--rules") {
      usage(`unknown flag: ${flag}`);
    }
    if (value === undefined) value = argv[++i];
    if (value === undefined || value.startsWith("--")) usage(`${flag} needs a value`);
    out[flag.slice(2)] = value;
  }
  return out;
}

/* ---------- rules ---------- */

const OPS = {
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b, // strict on purpose — "1840" is not 1840
  "!=": (a, b) => a !== b,
};

function validateRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "not an object";
  const type = rule.type || "threshold";
  if (type !== "threshold" && type !== "dtc") return `unknown type "${type}"`;
  for (const k of ["for_s", "cooldown_s"]) {
    if (k in rule && (typeof rule[k] !== "number" || rule[k] < 0)) {
      return `${k} must be a non-negative number of seconds`;
    }
  }
  if (type === "dtc") return null;
  if (typeof rule.path !== "string" || !rule.path) return "threshold rules need a path";
  if (!(rule.op in OPS)) return `op must be one of ${Object.keys(OPS).join(" ")}`;
  if (!("value" in rule)) return "threshold rules need a value";
  return null;
}

function loadRules(fileArg) {
  const file = fileArg ? path.resolve(fileArg) : path.join(__dirname, "rules.json");
  if (!fs.existsSync(file)) {
    console.error(`[alerts] no rules file at ${file}`);
    if (!fileArg) {
      console.error(
        "[alerts] copy kits/alerts/rules.example.json to kits/alerts/rules.json and make it yours"
      );
    }
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[alerts] ${file} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error(`[alerts] ${file} must be a JSON array of rules`);
    process.exit(1);
  }
  const rules = [];
  parsed.forEach((rule, i) => {
    const problem = validateRule(rule);
    if (problem) {
      // one bad rule is skipped, not fatal — the rest keep watching
      console.error(`[alerts] rule ${i + 1} skipped: ${problem}`);
      return;
    }
    rules.push({ ...rule, type: rule.type || "threshold" });
  });
  if (!rules.length) {
    console.error(`[alerts] no usable rules in ${file}`);
    process.exit(1);
  }
  return rules;
}

/* ---------- evaluating a frame ---------- */

/**
 * Walk a dotted path ("obd.coolant_c", "obd.pids.0C") into a frame without
 * ever throwing. Every sub-object in the Core contract is OPTIONAL — any hop
 * may simply not be there this cycle — so a missing step returns undefined
 * instead of blowing up.
 */
function walk(frame, dotted) {
  let v = frame;
  for (const key of dotted.split(".")) {
    if (v == null || typeof v !== "object") return undefined;
    v = v[key];
  }
  return v;
}

/** Does this threshold rule's condition hold for this frame? */
function holds(rule, frame) {
  const value = walk(frame, rule.path);
  // Absent means "no data this cycle", never zero. We only trust what we can
  // see, so an absent reading counts as the condition NOT holding (which also
  // resets a running for_s clock — continuous evidence or no alarm).
  if (value === undefined || value === null) return { ok: false, value };
  // The ordering ops only make sense number-to-number.
  if (rule.op !== "==" && rule.op !== "!=") {
    if (typeof value !== "number" || typeof rule.value !== "number") {
      return { ok: false, value };
    }
  }
  return { ok: OPS[rule.op](value, rule.value), value };
}

/** "{value}" / "{codes}" / "{device}" / "{path}" — tiny, predictable, done.
 *  A token with nothing to say (e.g. {codes} in a threshold rule) is left
 *  as-is, so a template mistake is visible instead of silently blank. */
function render(template, ctx) {
  return String(template).replace(/\{(value|codes|device|path)\}/g, (token, key) =>
    ctx[key] == null ? token : String(ctx[key])
  );
}

/**
 * Build the per-frame evaluator. All rule state lives here, in memory:
 * `since` (when a threshold condition started holding), `lastFired` (for
 * cooldowns) and `prev` (the last dtc-carrying frame's code set). Restarting
 * the watcher forgets all three — see "honest limits" in the README.
 */
function makeEngine(rules) {
  const state = rules.map(() => ({ since: null, lastFired: -Infinity, prev: null }));

  return function onFrame(device, ts, frame) {
    // Rules are clocked on the frame's CAPTURE time (the ts the kit stamped,
    // age_ms already subtracted), not on arrival — so a batched catch-up
    // evaluates with honest timing instead of everything landing "now".
    const t = Date.parse(ts) || Date.now();

    rules.forEach((rule, i) => {
      const st = state[i];

      if (rule.type === "dtc") {
        // No dtc object means "no data this cycle", not "codes cleared" —
        // the baseline only moves when the frame actually reports codes.
        if (!frame.dtc) return;
        const codes = Array.isArray(frame.dtc.codes) ? frame.dtc.codes.map(String) : [];
        const prev = st.prev;
        // The first dtc-carrying frame seeds the baseline without firing:
        // we alert on codes that APPEAR while we watch, not on whatever was
        // already stored in the car when we attached.
        if (prev === null) { st.prev = new Set(codes); return; }
        const cooling = t - st.lastFired < (rule.cooldown_s || 0) * 1000;
        const fresh = codes.filter((c) => !prev.has(c));
        // A code that appears mid-cooldown stays OUT of the baseline, so it
        // still fires once the window opens — suppressed is not forgotten.
        // Cleared codes leave the baseline either way (clear-then-return
        // later counts as fresh again).
        st.prev = new Set(cooling ? codes.filter((c) => prev.has(c)) : codes);
        if (!fresh.length || cooling) return;
        st.lastFired = t;
        const joined = fresh.join(", ");
        fire(rule, "dtc", { device, value: joined, codes: joined, path: "dtc.codes" }, ts);
        return;
      }

      // threshold
      const { ok, value } = holds(rule, frame);
      if (!ok) {
        st.since = null; // condition (or the reading itself) went away — reset
        return;
      }
      if (st.since === null) st.since = t;
      if (t - st.since < (rule.for_s || 0) * 1000) return; // not held long enough yet
      if (t - st.lastFired < (rule.cooldown_s || 0) * 1000) return; // fired too recently
      st.lastFired = t;
      fire(
        rule,
        `${rule.path} ${rule.op} ${rule.value}`,
        { device, value, codes: null, path: rule.path },
        ts
      );
    });
  };
}

/* ---------- actions ---------- */

/** A rule fired: say so on the console (always), then run its actions. */
function fire(rule, ruleId, ctx, ts) {
  const fallback = rule.type === "dtc" ? "New trouble code: {codes}" : "{path} is {value}";
  const message = render(rule.message || fallback, ctx);
  console.log(`[alert] ${ts} ${ctx.device} — ${message}`);
  if (rule.webhook) {
    deliver(rule.webhook, {
      device_id: ctx.device,
      rule: ruleId,
      message,
      value: ctx.value,
      ts,
    });
  }
  if (rule.discord) {
    // Discord webhooks want exactly this shape — nothing else to it.
    deliver(rule.discord, { content: message });
  }
}

/**
 * POST JSON somewhere, best-effort: one try, one retry, then a log line and
 * we move on. An action must never crash the watcher — a flaky webhook costs
 * you a complaint on stderr, not uptime.
 */
async function deliver(url, body) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === 2) {
        console.error(`[alerts] POST ${url} failed twice (${err.message}) — giving up`);
      }
    }
  }
}

/* ---------- the SSE client, hand-rolled on purpose ------------------------
 *
 * Server-Sent Events is a never-ending HTTP response of plain text. The
 * entire grammar the kit emits:
 *
 *   retry: 3000         suggested reconnect delay, in milliseconds
 *   : ping              a comment — the kit's keep-alive, safe to ignore
 *   data: {...}         an event's payload; a BLANK LINE dispatches it
 *
 * Browsers wrap this in EventSource; in Node we read the fetch body stream
 * and split it into lines ourselves. That's genuinely all a client is.
 */
async function subscribe(url, onEvent) {
  let retryMs = 3000; // until the server's `retry:` says otherwise
  let failures = 0; // consecutive — resets once a connection succeeds

  for (;;) {
    try {
      const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      console.log(`[alerts] connected — ${url}`);
      failures = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder(); // stream-safe UTF-8 across chunk splits
      let buf = ""; // partial line carried between reads
      let data = []; // data lines of the event being assembled

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break; // server hung up — drop to the reconnect path
        buf += decoder.decode(value, { stream: true });

        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);

          if (line === "") {
            // Blank line = "the event is complete, hand it over".
            if (data.length) onEvent(data.join("\n"));
            data = [];
          } else if (line.startsWith("data:")) {
            data.push(line.slice(5).trimStart());
          } else if (line.startsWith("retry:")) {
            const ms = Number(line.slice(6).trim());
            if (Number.isFinite(ms) && ms >= 0) retryMs = ms;
          }
          // Comment lines (": ping") and fields the kit never sends
          // (`event:`, `id:`) fall through here ignored — per the spec.
        }
      }
    } catch (err) {
      console.error(`[alerts] stream error: ${err.message}`);
    }

    // Reconnect like a browser: the server-suggested delay, doubled per
    // consecutive failure, capped — a dead server costs one probe per 30 s.
    const wait = Math.min(retryMs * 2 ** failures, 30_000);
    failures++;
    console.log(`[alerts] reconnecting in ${Math.round(wait / 1000)} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/* ---------- main ---------- */

async function pickDevice(base) {
  let body;
  try {
    const res = await fetch(`${base}/api/devices`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new Error(`could not list devices at ${base} (${err.message}) — is the kit running?`);
  }
  const devices = Array.isArray(body?.devices) ? body.devices : [];
  if (!devices.length) {
    throw new Error(
      `no devices at ${base} yet — push a frame first, or pass --device <id> to watch for one`
    );
  }
  // /api/devices sorts most-recently-seen first, so the pick is just [0].
  const id = devices[0].id;
  console.log(
    `[alerts] no --device given — watching ${id} (most recently seen of ${devices.length})`
  );
  return id;
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const base = (args.base || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const rules = loadRules(args.rules);
  console.log(`${PRODUCT_NAME} DevKit — alerts watcher`);
  const device = args.device || (await pickDevice(base));
  const onFrame = makeEngine(rules);

  console.log(`[alerts] ${rules.length} rule${rules.length === 1 ? "" : "s"} armed — watching ${device}`);
  await subscribe(`${base}/api/devices/${encodeURIComponent(device)}/live`, (payload) => {
    // The kit sends one JSON object per event: { device_id, ts, frame }.
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return; // not ours — skip, never crash on a weird payload
    }
    if (!msg || typeof msg !== "object" || !msg.frame || typeof msg.frame !== "object") return;
    onFrame(msg.device_id || device, msg.ts || new Date().toISOString(), msg.frame);
  });
}

main().catch((err) => {
  console.error(`[alerts] ${err.message}`);
  process.exit(1);
});
