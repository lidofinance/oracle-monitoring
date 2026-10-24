import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exampleScenario } from "../app/vebo-simulation.ts";

async function render(path = "/", extraHeaders = {}) {
  const entryUrl = new URL("../dist/server/index.js", import.meta.url);
  entryUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: handler } = await import(entryUrl.href);

  return handler(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html", ...extraHeaders },
    }),
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
  assert.match(html, /aria-label="Back to home"/);
});


test("server-renders the depositor dashboard without claiming bot liveness", async () => {
  const response = await render("/depositor");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Lido Depositor Watch<\/title>/i);
  assert.match(html, /Depositable ETH/);
  assert.match(html, /aria-label="Back to home"/);
  assert.match(html, /Total pooled ETH/);
  assert.match(html, /Depositor balance/);
  assert.doesNotMatch(html, /Ethereum validator exit queue|Withdrawal funding balance|Withdrawal queue information/);
  assert.doesNotMatch(html, /Bot is online|Bot is running/i);
});


test("server-renders the Council dashboard without inferring daemon process health", async () => {
  const response = await render("/council");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Lido Council Watch/);
  assert.match(html, /Council daemons/);
  assert.ok(html.indexOf('id="dsm-activity"') < html.indexOf('id="guardians"'));
  assert.doesNotMatch(html, /Ethereum funding|Gnosis funding|Polygon funding|Across .*delegate wallets/);
  assert.match(html, /aria-label="Back to home"/);
  assert.match(html, /role="tablist" aria-label="Council network"/);
  assert.match(html, /id="council-tab-mainnet"/);
  assert.match(html, /id="council-tab-hoodi"/);
  assert.match(html, /Gnosis/);
  assert.match(html, /Polygon/);
  assert.doesNotMatch(html, /All daemons online|All daemons running/i);
});

test("Depositor rejects an unknown exit queue network without a Mainnet fallback", async () => {
  const response = await render("/api/depositor?network=unknown&view=exit-queue");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Choose mainnet or hoodi.");
});

test("Depositor rejects an unknown Lido exit-balance network before collecting history", async () => {
  const response = await render("/api/depositor?network=unknown&view=exit-balances");
  assert.equal(response.status, 400);
});

test("Council rejects unknown networks before making any chain requests", async () => {
  const response = await render("/api/council?network=unknown");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Unknown Council network");
});

test("VEBO starts by loading Mainnet values without exposing fictional defaults", async () => {
  const response = await render("/vebo-simulator");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /VEBO Exit Simulator/);
  assert.match(html, /aria-label="Back to home"/);
  assert.match(html, /Loading current Mainnet values/);
  assert.match(html, /Loading Mainnet defaults/);
  assert.match(html, /Use the fictional example/);
  assert.doesNotMatch(html, /Operator Alpha|fictional validator indexes|aria-label="Maximum exit requests"|value="4096"/);
  assert.doesNotMatch(html, /Guaranteed next report/);
});
test("VEBO simulator rejects unknown networks without collecting a snapshot", async () => {
  const response = await render("/api/vebo-simulator?network=invalid");
  assert.equal(response.status, 400);
});

test("VEBO reuses persisted ten-minute snapshots without mixing networks, RPCs or state modes", async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"vebo-cache-test-"));
  const before=process.env.VEBO_CACHE_DIR;
  process.env.VEBO_CACHE_DIR=directory;
  const finished=Date.now();
  try {
    for(const network of ["mainnet","hoodi"]) {
      const scenario=exampleScenario(network);scenario.demandETH=network==="mainnet"?111:222;
      const data={scenario,meta:{network,reference:"finalized",source:"live",keyDataVersion:1}};
      await fs.writeFile(path.join(directory,`${network}-finalized.json`),JSON.stringify({finished,data}));
    }
    const responses=await Promise.all(["mainnet","hoodi"].map(network=>render(`/api/vebo-simulator?network=${network}&state=finalized`)));
    for(const [i,response] of responses.entries()) {
      assert.equal(response.status,200);const body=await response.json();
      assert.equal(body.status,"ready");assert.equal(body.scenario.network,i===0?"mainnet":"hoodi");
      assert.equal(body.scenario.demandETH,i===0?111:222);assert.equal(body.meta.reference,"finalized");
      assert.deepEqual(body.cache,{storedAt:finished,expiresAt:finished+600_000});
    }
    const selected=exampleScenario('mainnet');selected.demandETH=333;
    await fs.writeFile(path.join(directory,'mainnet-rpc-publicnode-finalized.json'),JSON.stringify({finished,data:{scenario:selected,meta:{network:'mainnet',reference:'finalized',source:'live',keyDataVersion:1}}}));
    const selectedResponse=await render('/api/vebo-simulator?network=mainnet&state=finalized',{'x-lido-rpc':'publicnode'});
    assert.equal(selectedResponse.status,200);assert.equal((await selectedResponse.json()).scenario.demandETH,333);
    const again=await render('/api/vebo-simulator?network=mainnet&state=finalized');
    assert.equal(again.status,200);const cached=await again.json();assert.equal(cached.scenario.demandETH,111);
    assert.deepEqual(cached.cache,{storedAt:finished,expiresAt:finished+600_000});
    const invalid=await render("/api/vebo-simulator?state=head");assert.equal(invalid.status,400);
  } finally {
    if(before===undefined)delete process.env.VEBO_CACHE_DIR;else process.env.VEBO_CACHE_DIR=before;
    await fs.rm(directory,{recursive:true,force:true});
  }
});

test("renders Consolidation Watch with network tabs and explicit CMv1 coverage", async () => {
  const response=await render('/consolidation');assert.equal(response.status,200);
  const html=await response.text();assert.match(html,/<title>Lido Consolidation Watch<\/title>/);
  assert.match(html,/aria-label="Consolidation network"/);assert.match(html,/Mainnet/);assert.match(html,/Hoodi/);
  assert.match(html,/CMv1 requested coverage/);
  assert.match(html, /aria-label="Back to home"/);assert.match(html,/oldest first/);
  assert.doesNotMatch(html,/Bot is online|All consolidations completed/);
});
test("consolidation rejects invalid network, view and page before remote reads", async () => {
  for(const query of ['network=invalid','view=invalid','view=transactions&page=-1','view=transactions&page=bad']){
    const response=await render(`/api/consolidation?${query}`);assert.equal(response.status,400);
  }
});

test("portal links every dashboard and preserves the selected network", async () => {
  for(const network of ['mainnet','hoodi']){
    const response=await render(`/portal?network=${network}`);assert.equal(response.status,200);
    const html=await response.text();assert.match(html,/<title>Lido Watch · Protocol Observatory<\/title>/);
    for(const destination of ['/oracle/overview','/depositor/','/council','/vebo-simulator','/consolidation','/withdrawals','/oracle/telemetry','/oracle/reports'])assert.ok(html.includes(`href="${destination}?network=${network}"`),`Missing ${destination} for ${network}`);
    assert.match(html,/Network for dashboard links/);assert.doesNotMatch(html,/Every moving part|One place to watch/);
    assert.ok(html.includes(`href="/oracle/overview?network=${network}#members"`));
    assert.ok(html.includes(`href="/withdrawals?network=${network}#funding-balance"`));
    assert.ok(html.includes(`href="/consolidation?network=${network}#limits"`));
    assert.match(html,/Seats &amp; balances/);
    assert.doesNotMatch(html,/Bot is online|All bots healthy/);
  }
});

test("withdrawal forecast rejects unknown networks before starting collection", async () => {
  const response = await render("/api/depositor?network=sepolia&view=exit-forecast");
  assert.equal(response.status, 400);
});

test("liquidity view rejects unknown networks before collecting a snapshot", async () => {
  assert.equal((await render("/api/depositor?network=sepolia&view=liquidity")).status, 400);
});

test("Withdrawal Watch has moved widgets, home navigation and the correct initial network", async()=>{
 for(const network of ['mainnet','hoodi']){
  const response=await render(`/withdrawals?network=${network}`);assert.equal(response.status,200);
  const html=await response.text();assert.match(html,/<title>Lido Withdrawal Watch<\/title>/);
  assert.match(html,/Ethereum validator exit queue/);assert.match(html,/Withdrawal funding balance/);
  assert.match(html,/Withdrawal summary/);assert.match(html,/Ready to claim/);assert.match(html,/How a Lido withdrawal progresses/);
  assert.match(html,/aria-label="Back to home"/);assert.ok(html.includes(`https://f4ever.pl/?network=${network}`));
  assert.match(html,network==='hoodi'?/Hoodi testnet/:/Ethereum Mainnet/);
  assert.doesNotMatch(html,/Depositor balance|Protocol contracts|Depositor, delegate/);
 }
});

test("every dashboard provides the shared network-specific RPC picker",async()=>{
 for(const route of ['/portal','/','/depositor','/withdrawals','/council','/consolidation','/vebo-simulator']){
  const response=await render(`${route}?network=mainnet`);assert.equal(response.status,200);
  const html=await response.text();assert.match(html,/aria-label="Mainnet RPC endpoint"/);assert.match(html,/MEV Blocker/);assert.match(html,/aria-label="Data loading status:/);
  assert.doesNotMatch(html,/Auto-refresh every minute|Finalized chain data|Local simulation · no transactions|Balances on /);
 }
});
test("all collectors reject unknown RPC preset IDs before starting network work",async()=>{
 for(const route of ['depositor','council','consolidation','vebo-simulator','oracle-reports']){
  const response=await render(`/api/${route}?network=mainnet`,{'x-lido-rpc':'http://127.0.0.1'});
  assert.equal(response.status,400);assert.match((await response.json()).error,/supported RPC/);
 }
});
test("the selected RPC reaches the EL reader without silently falling back to Auto",async()=>{
 const previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(input)=>{calls.push(String(input));return Response.json({jsonrpc:'2.0',id:1,result:'0x2'});};
 try{
  const response=await render('/api/depositor?network=mainnet',{'x-lido-rpc':'publicnode'});
  assert.equal(response.status,503,'a wrong-chain response cannot become a valid snapshot');
  assert.ok(calls.length>0);assert.deepEqual([...new Set(calls)],['https://ethereum-rpc.publicnode.com']);
 }finally{globalThis.fetch=previous;}
});
