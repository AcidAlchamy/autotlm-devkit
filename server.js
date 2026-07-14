/* AutoTLM DevKit — your car's backend, on your laptop.
 *
 *   npm start   → ingest + query API + mini-console on one port
 *
 * The stage is set; your gear supplies the data. Provision an AutoTLM One's
 * cloud URL to the LAN address printed at startup and it streams here with
 * zero code changes — reading a real car, or the Car-Emulator on your bench.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config, PRODUCT_NAME, DEVKIT_VERSION } from "./src/config.js";
import { api, ingestUrls } from "./src/api.js";
import { initPersistence } from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable("x-powered-by");
app.use(api);
app.use(express.static(path.join(__dirname, "public")));

initPersistence();

app.listen(config.port, () => {
  const urls = ingestUrls();
  console.log(`
  ${PRODUCT_NAME} DevKit v${DEVKIT_VERSION} — local telemetry backend
  ──────────────────────────────────────────────────────────
  console   http://localhost:${config.port}
  ingest    ${urls.join("\n            ")}
  token     ${config.token}   (override: DEVKIT_TOKEN=... npm start)
  persist   ${config.persist ? `on → ${config.persistFile}` : "off (DEVKIT_PERSIST=1 to enable)"}
  ──────────────────────────────────────────────────────────
  Provision your AutoTLM One's cloud URL to the ingest address
  above (LAN one for a device on your network) + the token, and
  it streams straight here. The console fills in as frames land.
`);
});
