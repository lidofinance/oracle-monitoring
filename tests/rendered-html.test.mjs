import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exampleScenario } from "../app/vebo-simulation.ts";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the oracle monitor shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Lido Oracle Watch<\/title>/i);
  assert.match(html, /Lido Oracle Watch/);
  assert.match(html, /Onchain operations console/);
  assert.match(html, /Overview/);
  assert.match(html, /Telemetry details/);
  assert.match(html, /Oracle reports/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});


test("server-renders the depositor dashboard without claiming bot liveness", async () => {
  const response = await render("/depositor");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Lido Depositor Watch<\/title>/i);
  assert.match(html, /Depositable ETH/);
  assert.match(html, /Total pooled ETH/);
  assert.match(html, /Depositor balance/);
  assert.doesNotMatch(html, /Bot is online|Bot is running/i);
});


test("server-renders the Council dashboard without inferring daemon process health", async () => {
  const response = await render("/council");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Lido Council Watch/);
  assert.match(html, /Council daemons/);
  assert.match(html, /role="tablist" aria-label="Council network"/);
  assert.match(html, /id="council-tab-mainnet"/);
  assert.match(html, /id="council-tab-hoodi"/);
  assert.match(html, /Gnosis/);
  assert.match(html, /Polygon/);
  assert.doesNotMatch(html, /All daemons online|All daemons running/i);
});

test("Council rejects unknown networks before making any chain requests", async () => {
  const response = await render("/api/council?network=unknown");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Unknown Council network");
});

test("renders the VEBO simulator with explicit scenario assumptions", async () => {
  const response = await render("/vebo-simulator");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /VEBO Exit Simulator/);
  assert.match(html, /Maximum exit requests/);
  assert.match(html, /Sanity limit/);
  assert.match(html, /fictional validator indexes/);
  assert.match(html, /Operator weight/);
  assert.doesNotMatch(html, /Guaranteed next report/);
});
test("VEBO simulator rejects unknown networks without collecting a snapshot", async () => {
  const response = await render("/api/vebo-simulator?network=invalid");
  assert.equal(response.status, 400);
});

test("VEBO cached snapshots remain isolated by network and state mode", async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"vebo-cache-test-"));
  const before=process.env.VEBO_CACHE_DIR;
  process.env.VEBO_CACHE_DIR=directory;
  try {
    for(const network of ["mainnet","hoodi"]) {
      const scenario=exampleScenario(network);scenario.demandETH=network==="mainnet"?111:222;
      const data={scenario,meta:{network,reference:"finalized",source:"live"}};
      await fs.writeFile(path.join(directory,`${network}-finalized.json`),JSON.stringify({finished:Date.now(),data}));
    }
    const responses=await Promise.all(["mainnet","hoodi"].map(network=>render(`/api/vebo-simulator?network=${network}&state=finalized`)));
    for(const [i,response] of responses.entries()) {
      assert.equal(response.status,200);const body=await response.json();
      assert.equal(body.status,"ready");assert.equal(body.scenario.network,i===0?"mainnet":"hoodi");
      assert.equal(body.scenario.demandETH,i===0?111:222);assert.equal(body.meta.reference,"finalized");
    }
    const invalid=await render("/api/vebo-simulator?state=head");assert.equal(invalid.status,400);
  } finally {
    if(before===undefined)delete process.env.VEBO_CACHE_DIR;else process.env.VEBO_CACHE_DIR=before;
    await fs.rm(directory,{recursive:true,force:true});
  }
});
