import assert from "node:assert/strict";
import test from "node:test";

import {
  availableModules,
  isOracleModule,
  moduleFromMessage,
  parseTelemetrySetup,
  telemetryEventFromTopic,
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

test("DataBus event ids map to telemetry event kinds", () => {
  assert.equal(
    telemetryEventFromTopic(
      "0x84728A84725A206F8EC5A2AB533D0890029ADE3FCA0563B61DCA1BE60D73F40C",
    ),
    "startup",
  );
  assert.equal(
    telemetryEventFromTopic(
      "0x2b819b2aa7a0f65647aa591f4b0db6b42b9cbd798674363c2217719c8ddc0126",
    ),
    "report",
  );
  assert.equal(
    telemetryEventFromTopic(
      "0xc175062d338aeb0f6c17720126be534a0113654b826c93e62a34bd23cbe58b36",
    ),
    "diagnostic",
  );
  assert.equal(telemetryEventFromTopic("0x00"), "unknown");
});

test("startup telemetry exposes the oracle setup", () => {
  const startup = JSON.stringify({
    chain_id: 560048,
    version: "8.0.7",
    module: "csm_0x02",
    data: {
      delegation_contract_address: "0xAFca4694c06720Ad03037db3760a920320037217",
      kapi_version: "4.0.4",
    },
  });
  assert.deepEqual(parseTelemetrySetup(startup), {
    version: "8.0.7",
    kapiVersion: "4.0.4",
    delegationContract: "0xafca4694c06720ad03037db3760a920320037217",
  });
  const report = JSON.stringify({
    chain_id: 1,
    version: "8.1.0",
    module: "cm",
    data: { l_epoch: 1, r_epoch: 2, ready: 3 },
  });
  assert.deepEqual(parseTelemetrySetup(report), {
    version: "8.1.0",
    kapiVersion: undefined,
    delegationContract: undefined,
  });
  assert.deepEqual(parseTelemetrySetup("not json"), {});
});
