import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, encodeBytes32String } from 'ethers';
import { COUNCIL_NETWORKS, COUNCIL_CHAINS, councilNetwork, COUNCIL_BUS_ABI, COUNCIL_DSM, COUNCIL_EDF, parseCouncilBus, decodeCouncilDsm, summarizeCouncil, unpackCouncilBytes } from '../app/council-data.ts';
const guardian = '0x0000000000000000000000000000000000000001';
const wallet = '0x0000000000000000000000000000000000000002';
const dsm = '0x0000000000000000000000000000000000000003';
const empty32 = '0x' + '00'.repeat(32);
function bus(name, payload) {
  const event = COUNCIL_BUS_ABI.encodeEventLog(COUNCIL_BUS_ABI.getEvent(name), [wallet,payload]);
  return {address:dsm,topics:event.topics,data:AbiCoder.defaultAbiCoder().encode(['bytes'],[event.data]),blockNumber:'0x64',transactionHash:'0xabc',logIndex:'0x1'};
}
test('decodes the actual DataBus anonymous-event bytes envelope and Council ping', () => {
  const log = bus('MessagePingV1',[26247500n,[encodeBytes32String('4.1.2')]]);
  const event = parseCouncilBus(log,'gnosis',1000);
  assert.equal(event.kind,'ping'); assert.equal(event.sender,wallet); assert.equal(event.version,'4.1.2');
  assert.equal(event.referenceBlock,26247500); assert.equal(event.block,100); assert.equal(event.stage,'message');
});
test('deposit attestations retain module, nonce and deposit root without pretending ETH was moved', () => {
  const event = parseCouncilBus(bus('MessageDepositV1',[200n,empty32,empty32,3n,42n,[empty32,empty32],[encodeBytes32String('4.1.2')]]),'polygon',1000);
  assert.equal(event.kind,'deposit'); assert.equal(event.moduleId,3); assert.equal(event.payload.nonce,'42'); assert.equal(event.payload.depositRoot,empty32);
  assert.equal(event.stage,'message'); assert.equal('ethAmount' in event,false);
});
test('unvet payloads preserve packed uint64 operator IDs and uint128 target vetted counts', () => {
  const ids='0x'+(123n).toString(16).padStart(16,'0')+(456n).toString(16).padStart(16,'0');
  const counts='0x'+(10n).toString(16).padStart(32,'0')+(20n).toString(16).padStart(32,'0');
  const event=parseCouncilBus(bus('MessageUnvetV1',[200n,empty32,3n,4n,ids,counts,[empty32,empty32],[encodeBytes32String('4.1.2')]]),'gnosis',1000);
  assert.deepEqual(event.payload.operatorIds,['123','456']); assert.deepEqual(event.payload.vettedKeysCounts,['10','20']);
  assert.throws(()=>unpackCouncilBytes('0x12',8));
});
test('both pause message versions decode and malformed envelopes fail explicitly', () => {
  assert.equal(parseCouncilBus(bus('MessagePauseV2',[1n,empty32,[empty32,empty32],2n,[encodeBytes32String('4')]]),'gnosis',1000).moduleId,2);
  assert.equal(parseCouncilBus(bus('MessagePauseV3',[1n,empty32,[empty32,empty32],[encodeBytes32String('4')]]),'gnosis',1000).kind,'pause');
  assert.throws(()=>parseCouncilBus({...bus('MessagePingV1',[1n,[empty32]]),data:'0x12'},'gnosis',1000));
});
test('DSM direct and EDF calls only count when the decoded target is the actual DSM', () => {
  const input=COUNCIL_DSM.encodeFunctionData('pauseDeposits',[100n,[guardian,'0x1234']]);
  const direct=decodeCouncilDsm({to:dsm,from:wallet,input},dsm);
  assert.equal(direct.kind,'pause'); assert.equal(direct.guardian,guardian);
  const wrapped=COUNCIL_EDF.encodeFunctionData('execute',[dsm,input]);
  assert.equal(decodeCouncilDsm({to:guardian,from:wallet,input:wrapped},dsm).kind,'pause');
  assert.equal(decodeCouncilDsm({to:guardian,from:wallet,input:COUNCIL_EDF.encodeFunctionData('execute',[wallet,input])},dsm),null);
  assert.equal(decodeCouncilDsm({to:wallet,from:guardian,input},dsm),null);
});
test('summaries count full-window messages separately from successful and reverted DSM calls', () => {
  const today=Date.UTC(2026,9,22)/1000;
  const ping={...parseCouncilBus(bus('MessagePingV1',[1n,[empty32]]),'gnosis',today),guardian,currentKey:true,guardians:[guardian]};
  const deposit={...ping,id:'deposit',kind:'deposit',stage:'execution'};
  const failed={...deposit,id:'failed',kind:'unvet',success:false};
  const former={...ping,id:'former',currentKey:false,timestamp:today+1};
  const outOfWindow={...ping,id:'old',timestamp:today-7*86400};
  const data=summarizeCouncil([ping,deposit,failed,former,outOfWindow],[{address:guardian}],today+3600);
  assert.equal(data.total,4); assert.equal(data.totals.messages,2); assert.equal(data.totals.depositsExecuted,1); assert.equal(data.totals.unvets,0); assert.equal(data.totals.failed,1);
  assert.equal(data.members[0].daily[6],2); assert.equal(data.members[0].dailyPings[6],2); assert.equal(data.daily[6].ping,2); assert.equal(data.daily[6].executions,1); assert.equal(data.members[0].last.id,'former'); assert.equal(data.members[0].lastCurrent.id,ping.id);
});

test('a busy ping stream cannot hide older DSM actions from ledger filters', () => {
  const today=Date.UTC(2026,9,22)/1000;
  const ping={...parseCouncilBus(bus('MessagePingV1',[1n,[empty32]]),'gnosis',today),guardian,currentKey:true,guardians:[guardian]};
  const messages=Array.from({length:600},(_,i)=>({...ping,id:`ping-${i}`,timestamp:today+i+1}));
  const dsmCall={...ping,id:'dsm-call',stage:'execution',kind:'unvet'};
  const summary=summarizeCouncil([...messages,dsmCall],[{address:guardian}],today+1000);
  assert.equal(summary.totals.pings,600); assert.equal(summary.events.length,501);
  assert.ok(summary.events.some(event=>event.id==='dsm-call')); assert.equal(summary.totals.unvets,1);
});

test('current EDF messages decode opaque signatures in Deposit V2, Pause V4 and Unvet V2', () => {
  const signature='0x'+'ab'.repeat(65);
  assert.equal(COUNCIL_BUS_ABI.getEvent('MessageDepositV2').topicHash,'0xcf64c19806fe2ec395d2dec6ce5d30751590628d5bd5c856f20c19596ec6d754');
  const deposit=parseCouncilBus(bus('MessageDepositV2',[200n,empty32,empty32,3n,42n,signature,[encodeBytes32String('4.1.2')]]),'gnosis',1000);
  assert.equal(deposit.kind,'deposit');assert.equal(deposit.payload.nonce,'42');assert.equal(deposit.version,'4.1.2');
  const pause=parseCouncilBus(bus('MessagePauseV4',[200n,empty32,signature,[encodeBytes32String('4.1.2')]]),'gnosis',1000);
  assert.equal(pause.kind,'pause');
  const unvet=parseCouncilBus(bus('MessageUnvetV2',[200n,empty32,3n,42n,'0x0000000000000001','0x00000000000000000000000000000002',signature,[encodeBytes32String('4.1.2')]]),'gnosis',1000);
  assert.deepEqual(unvet.payload.operatorIds,['1']);assert.deepEqual(unvet.payload.vettedKeysCounts,['2']);
});

test('Council networks isolate execution contracts, guardian aliases and message transports', () => {
  assert.equal(councilNetwork(null), 'mainnet');
  assert.equal(councilNetwork('hoodi'), 'hoodi');
  assert.equal(councilNetwork('polygon'), null);
  const mainnet = COUNCIL_NETWORKS.mainnet, hoodi = COUNCIL_NETWORKS.hoodi;
  assert.notEqual(mainnet.locator.toLowerCase(), hoodi.locator.toLowerCase());
  assert.equal(COUNCIL_CHAINS[hoodi.executionChain].chainId, 560048);
  assert.deepEqual(hoodi.busChains.map(c => COUNCIL_CHAINS[c].chainId), [10200]);
  for (const address of Object.keys(hoodi.labels)) assert.equal(mainnet.labels[address], undefined);
  for (const chain of hoodi.balanceChains) assert.equal(mainnet.balanceChains.includes(chain), false);
  const ping = parseCouncilBus(bus('MessagePingV1', [123n, [encodeBytes32String('4.1.2')]]), hoodi.busChains[0], 1000);
  assert.equal(ping.chain, 'chiado');
  assert.match(COUNCIL_CHAINS[ping.chain].explorer, /chiado/);
});
