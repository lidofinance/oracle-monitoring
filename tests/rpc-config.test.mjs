import assert from "node:assert/strict";
import test from "node:test";

import { parseRpcList, serverRpcs } from "../app/rpc-config.ts";

test("empty or missing overrides keep the defaults", () => {
  const defaults = ["https://a.example", "https://b.example"];
  assert.deepEqual(parseRpcList(undefined, defaults), defaults);
  assert.deepEqual(parseRpcList("", defaults), defaults);
  assert.deepEqual(parseRpcList(" , ", defaults), defaults);
});

test("comma-separated overrides replace the defaults", () => {
  assert.deepEqual(
    parseRpcList(" https://x.example, https://y.example ", ["https://a.example"]),
    ["https://x.example", "https://y.example"],
  );
});

test("server RPC lists read the environment at call time", () => {
  const previous = process.env.HOODI_RPC_URLS;
  process.env.HOODI_RPC_URLS = "https://hoodi.example";
  try {
    assert.deepEqual(serverRpcs("hoodi"), ["https://hoodi.example"]);
  } finally {
    if (previous === undefined) delete process.env.HOODI_RPC_URLS;
    else process.env.HOODI_RPC_URLS = previous;
  }
  assert.ok(serverRpcs("mainnet").length > 1);
});
