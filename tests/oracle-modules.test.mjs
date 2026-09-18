import assert from "node:assert/strict";
import test from "node:test";

import {
  availableModules,
  isOracleModule,
  moduleFromMessage,
} from "../app/oracle-modules.ts";

test("telemetry module names map to console modules", () => {
  const message = (module) =>
    JSON.stringify({ chain_id: 560048, version: "8.0.7", module });
  assert.equal(moduleFromMessage(message("accounting"), ""), "ao");
  assert.equal(moduleFromMessage(message("ejector"), ""), "vebo");
  assert.equal(moduleFromMessage(message("csm"), ""), "csm");
  assert.equal(moduleFromMessage(message("csm_0x02"), ""), "csm_0x02");
  assert.equal(moduleFromMessage(message("cm"), ""), "cm");
});

test("plain-text telemetry keeps csm and csm_0x02 apart", () => {
  assert.equal(moduleFromMessage("csm_0x02 oracle started", ""), "csm_0x02");
  assert.equal(moduleFromMessage("csm oracle started", ""), "csm");
});

test("unknown payloads fall back to the topic hash", () => {
  const aoTopic =
    "0x0131b777a538d2509d6ec1bca91f61ac7a25b128baf35266feedf5a53eb4842a";
  assert.equal(moduleFromMessage("{}", aoTopic), "ao");
  assert.equal(moduleFromMessage("{}", "0x00"), "unknown");
});

test("module availability follows the per-network contract map", () => {
  assert.deepEqual(
    availableModules({ ao: "0x1", csm_0x02: "0x2" }).map(({ key }) => key),
    ["ao", "csm_0x02"],
  );
  assert.ok(isOracleModule("csm_0x02"));
  assert.ok(!isOracleModule("csm-0x02"));
  assert.ok(!isOracleModule(null));
});
