import assert from "node:assert/strict";
import test from "node:test";

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
  assert.match(html, /Gnosis/);
  assert.match(html, /Polygon/);
  assert.doesNotMatch(html, /All daemons online|All daemons running/i);
});
