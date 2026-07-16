/* AutoTLM DevKit — configuration.
 *
 * Everything is an environment variable with a dev-friendly default, so
 * `npm start` works with zero setup and Docker can override anything.
 */

// The product name lives in this ONE constant. Rebrand = edit this line.
export const PRODUCT_NAME = "AutoTLM";

export const DEVKIT_VERSION = "0.2.0";

export const config = {
  /** HTTP port for ingest, query API and the mini-console. */
  port: Number(process.env.PORT || 3000),

  /**
   * Bearer token your device must send on POST /api/ingest.
   * The default is deliberately simple — this is a local dev tool. Override it
   * the moment the kit is reachable by anyone but you:
   *   DEVKIT_TOKEN=something-long-and-random npm start
   */
  token: process.env.DEVKIT_TOKEN || "devkit",

  /** Max frames kept in memory per device (a ring buffer — oldest drop off). */
  bufferFrames: Number(process.env.DEVKIT_BUFFER || 5000),

  /**
   * Optional JSON-lines persistence. Set DEVKIT_PERSIST=1 and every accepted
   * frame is appended to data/telemetry.jsonl and replayed on next start.
   * Off by default: a starter should boot instant and stateless.
   */
  persist: process.env.DEVKIT_PERSIST === "1",
  persistFile: process.env.DEVKIT_PERSIST_FILE || "data/telemetry.jsonl",
};
