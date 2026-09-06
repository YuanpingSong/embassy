import assert from "node:assert/strict";
import test from "node:test";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { ledgerDefaults } from "../src/gateway/ledger.js";

test("configuration shares bounded ledger capacities and refuses incompatible combinations", () => {
  const env = { EMBASSY_STATE_DIR: "/tmp/emb-config" }, inventory = { host: "local", nodes: [] };
  assert.deepEqual(loadGatewayConfig(env, inventory).limits, ledgerDefaults);
  for (const [name, allowed, refused] of [
    ["EMBASSY_MAX_ROUTES", 128, 129], ["EMBASSY_MAX_QUEUE_MESSAGES", 100, 101],
    ["EMBASSY_MAX_QUEUE_PER_ROUTE", 20, 21], ["EMBASSY_MAX_IN_FLIGHT", 16, 17],
    ["EMBASSY_MAX_MESSAGE_BYTES", 16384, 16385], ["EMBASSY_EVENT_CAPACITY", 500, 501],
  ] as const) {
    assert.doesNotThrow(() => loadGatewayConfig({ ...env, [name]: String(allowed) }, inventory));
    assert.throws(() => loadGatewayConfig({ ...env, [name]: String(refused) }, inventory), { code: "INVALID_GATEWAY_CONFIGURATION" });
  }
  for (const bad of [
    { EMBASSY_MAX_QUEUE_MESSAGES: "5" }, { EMBASSY_MAX_QUEUE_BYTES: "1024" },
    { EMBASSY_STEERING_ENABLED: "yes" }, { EMBASSY_STATE_DIR: "relative" },
  ]) assert.throws(() => loadGatewayConfig({ ...env, ...bad }, inventory), { code: "INVALID_GATEWAY_CONFIGURATION" });
});
