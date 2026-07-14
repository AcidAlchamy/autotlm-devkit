/* AutoTLM DevKit — plain-English DTC decode.
 *
 * Two layers, so every code gets *some* meaning:
 *   1. a dictionary of the trouble codes you'll actually meet on the bench
 *   2. a structural decode of the SAE J2012 format (P/C/B/U + digit groups)
 *      for everything else
 *
 * decodeDtc(code) -> { code, text, detail, known } — never throws.
 */
(function () {
  "use strict";

  var COMMON = {
    P0087: "Fuel rail/system pressure too low",
    P0101: "Mass air flow (MAF) circuit range/performance",
    P0113: "Intake air temperature sensor circuit high",
    P0117: "Engine coolant temperature circuit low",
    P0118: "Engine coolant temperature circuit high",
    P0121: "Throttle position sensor circuit range/performance",
    P0128: "Coolant thermostat — temperature below regulating range",
    P0131: "O2 sensor circuit low voltage (bank 1 sensor 1)",
    P0135: "O2 sensor heater circuit (bank 1 sensor 1)",
    P0171: "System too lean (bank 1)",
    P0172: "System too rich (bank 1)",
    P0174: "System too lean (bank 2)",
    P0300: "Random/multiple cylinder misfire detected",
    P0301: "Cylinder 1 misfire detected",
    P0302: "Cylinder 2 misfire detected",
    P0303: "Cylinder 3 misfire detected",
    P0304: "Cylinder 4 misfire detected",
    P0325: "Knock sensor 1 circuit (bank 1)",
    P0335: "Crankshaft position sensor A circuit",
    P0401: "Exhaust gas recirculation (EGR) flow insufficient",
    P0420: "Catalyst system efficiency below threshold (bank 1)",
    P0430: "Catalyst system efficiency below threshold (bank 2)",
    P0440: "Evaporative emission (EVAP) system fault",
    P0442: "EVAP system leak detected (small leak)",
    P0455: "EVAP system leak detected (large leak)",
    P0500: "Vehicle speed sensor A fault",
    P0562: "System voltage low",
    P0563: "System voltage high",
    P0601: "Internal control module memory checksum error",
    P0700: "Transmission control system (MIL request)",
    C0035: "Left front wheel speed sensor circuit",
    B0001: "Driver frontal stage 1 deployment control",
    U0100: "Lost communication with ECM/PCM",
    U0121: "Lost communication with ABS control module"
  };

  var SYSTEMS = { P: "Powertrain", C: "Chassis", B: "Body", U: "Network" };
  var P_AREAS = {
    "0": "fuel & air metering / auxiliary emissions",
    "1": "fuel & air metering",
    "2": "fuel & air metering (injector circuit)",
    "3": "ignition system or misfire",
    "4": "auxiliary emission controls",
    "5": "vehicle speed / idle control",
    "6": "computer output circuit",
    "7": "transmission",
    "8": "transmission",
    "9": "transmission"
  };

  function structural(code) {
    var m = /^([PCBU])([0-3])(\d)(\d{2})$/.exec(code);
    if (!m) return "Unrecognized code format";
    var parts = [SYSTEMS[m[1]] || "Unknown system"];
    parts.push(m[2] === "0" || m[2] === "2" ? "generic (SAE)" : "manufacturer-specific");
    if (m[1] === "P" && P_AREAS[m[3]]) parts.push(P_AREAS[m[3]]);
    return parts.join(" · ");
  }

  window.decodeDtc = function (code) {
    code = String(code || "").toUpperCase().trim();
    if (COMMON[code]) {
      return { code: code, text: COMMON[code], detail: structural(code), known: true };
    }
    return {
      code: code,
      text: structural(code),
      detail: "Not in the common-code dictionary — structural decode shown.",
      known: false
    };
  };
})();
