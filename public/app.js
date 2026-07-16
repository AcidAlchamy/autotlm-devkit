/* AutoTLM DevKit — mini-console.
 *
 * A deliberately readable client of the kit's own query API:
 *   GET /api/devices                     → device picker
 *   GET /api/devices/:id/latest          → last-known frame on open
 *   GET /api/devices/:id/live   (SSE)    → everything live on this page
 *   GET /api/devices/:id/dtc             → diagnostics table
 *   GET /api/meta                        → ingest URL + token + counters
 *
 * No framework, no build step. View-source is the documentation.
 */
(function () {
  "use strict";

  var PRODUCT_NAME = "AutoTLM"; // rebrand = edit this line

  var $ = function (id) { return document.getElementById(id); };

  /* ================= tiny API client ==================================== */

  var API = {
    _json: function (url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    },
    meta: function () { return this._json("/api/meta"); },
    devices: function () { return this._json("/api/devices"); },
    latest: function (id) { return this._json("/api/devices/" + id + "/latest"); },
    dtc: function (id) { return this._json("/api/devices/" + id + "/dtc"); }
  };

  /* ================= dials (SVG arc gauges) ============================= */
  /* 240° sweep, drawn once, updated by stroke-dashoffset — cheap + smooth. */

  function makeDial(el, opts) {
    var W = 200, H = 170, cx = 100, cy = 92, r = 74;
    var START = 150, SWEEP = 240; // degrees
    function pt(deg, rad) {
      var a = (deg * Math.PI) / 180;
      return (cx + rad * Math.cos(a)).toFixed(1) + " " + (cy + rad * Math.sin(a)).toFixed(1);
    }
    function arcPath(rad) {
      return "M " + pt(START, rad) + " A " + rad + " " + rad + " 0 1 1 " + pt(START + SWEEP - 0.01, rad);
    }
    var len = (SWEEP / 360) * 2 * Math.PI * r;

    var ticks = "";
    for (var i = 0; i <= opts.ticks; i++) {
      var deg = START + (SWEEP * i) / opts.ticks;
      ticks += '<line class="dial-tick" x1="' + pt(deg, r - 7).replace(" ", '" y1="') +
        '" x2="' + pt(deg, r - 1).replace(" ", '" y2="') + '"/>';
      var v = opts.min + ((opts.max - opts.min) * i) / opts.ticks;
      ticks += '<text class="dial-num" text-anchor="middle" x="' +
        pt(deg, r - 18).replace(" ", '" y="') + '">' + Math.round(v * (opts.tickScale || 1)) + "</text>";
    }

    el.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '">' +
      '<path class="dial-face" stroke-width="8" d="' + arcPath(r) + '"/>' +
      '<path class="dial-glow" stroke-width="16" d="' + arcPath(r) + '" stroke-dasharray="' +
      len + '" stroke-dashoffset="' + len + '"/>' +
      '<path class="dial-arc" stroke-width="8" d="' + arcPath(r) + '" stroke-dasharray="' +
      len + '" stroke-dashoffset="' + len + '"/>' + ticks +
      '<text class="dial-value" text-anchor="middle" x="' + cx + '" y="' + (cy + 8) + '" font-size="30">—</text>' +
      '<text class="dial-unit" text-anchor="middle" x="' + cx + '" y="' + (cy + 26) + '" font-size="10">' + opts.unit + "</text>" +
      '<text class="dial-label" text-anchor="middle" x="' + cx + '" y="' + (H - 6) + '" font-size="11" letter-spacing="2">' + opts.label + "</text>" +
      "</svg>";

    var arc = el.querySelector(".dial-arc");
    var glow = el.querySelector(".dial-glow");
    var val = el.querySelector(".dial-value");
    return {
      set: function (v) {
        if (v == null) {
          arc.style.strokeDashoffset = glow.style.strokeDashoffset = len;
          val.textContent = "—"; val.setAttribute("class", "dial-value");
          return;
        }
        var f = Math.max(0, Math.min(1, (v - opts.min) / (opts.max - opts.min)));
        arc.style.strokeDashoffset = glow.style.strokeDashoffset = len * (1 - f);
        val.textContent = opts.fmt ? opts.fmt(v) : Math.round(v);
        var cls = "";
        if (opts.crit && v >= opts.crit) cls = "crit";
        else if (opts.warn && v >= opts.warn) cls = "warn";
        arc.setAttribute("class", "dial-arc" + (cls ? " " + cls : ""));
        glow.setAttribute("class", "dial-glow" + (cls ? " " + cls : ""));
        val.setAttribute("class", "dial-value" + (cls ? " " + cls : ""));
      }
    };
  }

  var dialSpeed = makeDial($("dial-speed"), { label: "SPEED", unit: "km/h", min: 0, max: 240, ticks: 6 });
  var dialRpm = makeDial($("dial-rpm"), { label: "ENGINE", unit: "rpm × 1000", min: 0, max: 8000, ticks: 8, tickScale: 0.001, warn: 6000, crit: 7000 });
  var dialCoolant = makeDial($("dial-coolant"), { label: "COOLANT", unit: "°C", min: 40, max: 130, ticks: 6, warn: 105, crit: 115 });

  /* ================= mini gauges ======================================== */

  function makeMini(el, label) {
    el.innerHTML =
      '<span class="m-lbl">' + label + '</span>' +
      '<div class="m-val">—</div>' +
      '<div class="m-bar"><div class="m-fill"></div></div>';
    var val = el.querySelector(".m-val"), fill = el.querySelector(".m-fill");
    return {
      set: function (v, text, frac, state) {
        val.innerHTML = v == null ? "—" : text;
        fill.style.width = v == null ? 0 : Math.max(0, Math.min(1, frac)) * 100 + "%";
        el.className = "mini" + (state ? " " + state : "");
      }
    };
  }

  var miniThrottle = makeMini($("mini-throttle"), "Throttle");
  var miniLoad = makeMini($("mini-load"), "Load");
  var miniVolts = makeMini($("mini-volts"), "Battery");
  var miniFuel = makeMini($("mini-fuel"), "Fuel");

  /* ================= status bar ========================================= */

  function setLive(state, label) {
    $("live-dot").className = "live-dot" + (state ? " " + state : "");
    $("live-label").textContent = label;
  }
  setInterval(function () {
    $("sb-clock").textContent = new Date().toISOString().slice(11, 19);
  }, 1000);

  /* ================= frame inspector ==================================== */

  var held = false;
  $("fi-hold").addEventListener("click", function () {
    held = !held;
    this.classList.toggle("held", held);
    this.textContent = held ? "RESUME" : "HOLD";
    $("inspector-note").textContent = held ? "frozen — click resume" : "raw telemetry, live";
  });

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* JSON syntax highlighting: walk the parsed value, emit spans. */
  function hi(v, indent) {
    var pad = "  ".repeat(indent);
    if (v === null) return '<span class="jz">null</span>';
    if (typeof v === "boolean") return '<span class="jb">' + v + "</span>";
    if (typeof v === "number") return '<span class="jn">' + v + "</span>";
    if (typeof v === "string") return '<span class="js">"' + esc(v) + '"</span>';
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      return "[\n" + v.map(function (x) { return pad + "  " + hi(x, indent + 1); }).join(",\n") + "\n" + pad + "]";
    }
    var keys = Object.keys(v);
    if (!keys.length) return "{}";
    return "{\n" + keys.map(function (k) {
      return pad + '  <span class="jk">"' + esc(k) + '"</span>: ' + hi(v[k], indent + 1);
    }).join(",\n") + "\n" + pad + "}";
  }

  function renderInspector(msg) {
    if (held) return;
    var json = JSON.stringify(msg.frame);
    $("fi-ts").textContent = msg.ts.slice(11, 23) + "Z";
    $("fi-size").textContent = json.length + " B";
    $("frame-json").innerHTML = hi(msg.frame, 0);
  }

  /* ================= frame → gauges ===================================== */

  var frames = 0;
  var lastDtcKey = null;

  function onFrame(msg) {
    var f = msg.frame || {};
    frames++;
    $("sb-frames").textContent = frames;
    setLive("on", "live");

    // Every sub-object is OPTIONAL in the frame contract — null-check all.
    var obd = f.obd || null;
    var gps = f.gps || null;
    var imu = f.imu || null;
    var dtc = f.dtc || null;

    $("badge-obd").className = "badge" + (obd && obd.connected ? " on" : "");
    $("badge-gps").className = "badge" + (gps && gps.fix ? " on" : "");
    $("badge-imu").className = "badge" + (imu ? " on" : "");
    var mil = !!(dtc && dtc.mil);
    $("badge-mil").className = "badge" + (mil ? " mil-on" : "");

    dialSpeed.set(obd ? obd.speed_kph : null);
    dialRpm.set(obd ? obd.rpm : null);
    dialCoolant.set(obd ? obd.coolant_c : null);

    if (obd && obd.throttle_pct != null) miniThrottle.set(obd.throttle_pct, obd.throttle_pct + " <small>%</small>", obd.throttle_pct / 100);
    else miniThrottle.set(null);
    if (obd && obd.load_pct != null) miniLoad.set(obd.load_pct, obd.load_pct + " <small>%</small>", obd.load_pct / 100);
    else miniLoad.set(null);
    if (obd && obd.volts != null) {
      var vState = obd.volts < 11 || obd.volts > 15.4 ? "crit" : obd.volts < 12.2 ? "warn" : "";
      miniVolts.set(obd.volts, obd.volts.toFixed(1) + " <small>V</small>", (obd.volts - 8) / 8, vState);
    } else miniVolts.set(null);
    var fuel = obd && obd.pids ? obd.pids["2F"] : null;
    if (fuel != null) miniFuel.set(fuel, Math.round(fuel) + " <small>%</small>", fuel / 100, fuel < 10 ? "crit" : fuel < 20 ? "warn" : "");
    else miniFuel.set(null);

    // device panel
    if (f.device && f.device.id) $("di-id").textContent = f.device.id;
    if (obd && obd.vin) $("di-vin").textContent = obd.vin;
    $("di-seen").textContent = "just now";
    $("di-rssi").textContent = f.device && f.device.rssi != null ? f.device.rssi + " dBm" : "—";
    // Practice what the README preaches: null-check INSIDE sub-objects too.
    // A fix flag without coordinates, or an imu missing an axis, is a frame
    // we render around — never a TypeError.
    $("di-pos").textContent = gps && gps.fix && typeof gps.lat === "number" && typeof gps.lng === "number"
      ? gps.lat.toFixed(5) + ", " + gps.lng.toFixed(5) + " · " + (gps.sats || "?") + " sats"
      : "no fix";
    $("di-imu").textContent = imu && typeof imu.ax === "number" && typeof imu.ay === "number" && typeof imu.az === "number"
      ? imu.ax.toFixed(2) + " / " + imu.ay.toFixed(2) + " / " + imu.az.toFixed(2) + " g"
      : "—";

    renderInspector(msg);

    // reload the DTC table only when the code set actually changes
    var key = (dtc && dtc.codes ? dtc.codes.slice().sort().join(",") : "") + "|" + mil;
    if (key !== lastDtcKey) {
      lastDtcKey = key;
      if (currentDevice) loadFaults(currentDevice);
    }
  }

  /* ================= diagnostics ======================================== */

  function loadFaults(id) {
    API.dtc(id).then(function (d) {
      var codes = d.codes || [];
      var active = codes.filter(function (c) { return c.active; });
      $("faults-mil").className = "badge" + (d.mil ? " mil-on" : "");
      var sum = $("faults-summary");
      if (!codes.length) {
        sum.innerHTML = "<b>No trouble codes on record.</b> The check-engine light is off and this device has never reported a DTC.";
        $("dtc-table").hidden = true;
        return;
      }
      sum.innerHTML = (d.mil ? "<b>Check-engine light is ON.</b> " : "Check-engine light is off. ") +
        active.length + " active / " + codes.length + " historical code" + (codes.length === 1 ? "" : "s") + ".";
      var tb = $("dtc-table").querySelector("tbody");
      tb.innerHTML = "";
      codes.forEach(function (c) {
        var info = window.decodeDtc(c.code);
        var tr = document.createElement("tr");
        tr.innerHTML =
          '<td><span class="dtc-code">' + esc(c.code) + "</span></td>" +
          "<td>" + esc(info.text) + '<span class="dtc-sub">' + esc(info.detail) + "</span></td>" +
          "<td>" + (c.active ? '<span class="dtc-active">ACTIVE</span>' : '<span class="dtc-cleared">CLEARED</span>') + "</td>" +
          "<td class='mono'>" + esc(c.first_seen.slice(0, 19).replace("T", " ")) + "</td>" +
          "<td class='mono'>" + esc(c.last_seen.slice(0, 19).replace("T", " ")) + "</td>";
        tb.appendChild(tr);
      });
      $("dtc-table").hidden = false;
    }).catch(function () { /* device may have vanished between polls */ });
  }

  /* ================= live stream / device selection ===================== */

  var es = null;
  var currentDevice = null;

  function selectDevice(id) {
    currentDevice = id;
    $("sb-dev").textContent = id;
    if (es) { es.close(); es = null; }
    setLive("", "connecting…");
    // show the last frame the device pushed immediately, so the console isn't
    // blank when you open it between drives; SSE then keeps it live.
    API.latest(id).then(function (m) { if (m && m.frame) onFrame(m); }).catch(function () { });
    es = new EventSource("/api/devices/" + id + "/live");
    es.onopen = function () { setLive("", "listening…"); };
    es.onerror = function () { setLive("err", "reconnecting"); };
    es.onmessage = function (e) {
      try { onFrame(JSON.parse(e.data)); } catch (err) { /* skip a bad frame */ }
    };
    loadFaults(id);
  }

  $("device-picker").addEventListener("change", function () {
    if (this.value) selectDevice(this.value);
  });

  function refreshDevices() {
    API.devices().then(function (d) {
      var devices = d.devices || [];
      var picker = $("device-picker");
      if (!devices.length) {
        setLive("", "waiting for first frame");
        return;
      }
      var current = picker.value;
      picker.innerHTML = devices.map(function (dev) {
        return '<option value="' + esc(dev.id) + '">' + esc(dev.name || dev.id) + "</option>";
      }).join("");
      if (devices.some(function (x) { return x.id === current; })) {
        picker.value = current;
      } else {
        picker.value = devices[0].id;
        selectDevice(devices[0].id);
      }
    }).catch(function () { setLive("err", "kit unreachable"); });
  }

  /* ================= meta / theme / boot ================================ */

  API.meta().then(function (m) {
    // prefer the LAN URL — that's the one a real device can reach
    var urls = m.ingest_urls || [];
    var ingest = urls[urls.length - 1] || "—";
    $("sb-ingest").textContent = ingest;
    document.title = m.product + " DevKit — local telemetry console";
    // fill the empty-state setup guide with the real values to provision
    var ou = $("onboard-url"); if (ou) ou.textContent = ingest;
    var ot = $("onboard-token"); if (ot && m.token) ot.textContent = m.token;
  }).catch(function () { });

  $("theme-toggle").addEventListener("click", function () {
    var next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("autotlm-devkit-theme", next); } catch (e) { }
  });

  refreshDevices();
  setInterval(refreshDevices, 5000);
})();
