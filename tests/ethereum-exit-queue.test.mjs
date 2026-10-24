import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeExitQueue, collectExitQueue, createExitQueueReader } from '../app/ethereum-exit-queue.ts';

const root = '0x' + 'ab'.repeat(32);
const genesis = 1_600_000_000, slot = 3200, observed = genesis + slot * 12;
const input = () => ({ network:'mainnet', slot, stateRoot:root, genesisTime:genesis, secondsPerSlot:12, slotsPerEpoch:32, withdrawalDelayEpochs:256,
  validators:[], consolidations:[], fetchedAt:observed + 10, source:{name:'Test Beacon',url:null} });
const validator = (index, balance = '32000000000', exit = '110', slashed = false) => ({ index:String(index), status:slashed?'active_slashed':'active_exiting',
  validator:{effective_balance:balance, activation_epoch:'1', exit_epoch:exit, slashed} });

test('sums compounding validator balances and uses assigned exit epochs for the tail', () => {
  const result = summarizeExitQueue({...input(), validators:[validator(1), validator(2,'2048000000000','120')]});
  assert.equal(result.validators,2);
  assert.equal(result.effectiveETH,'2080.0');
  assert.equal(result.firstExitAt,genesis+110*384);
  assert.equal(result.lastExitAt,genesis+120*384);
  assert.equal(result.withdrawalDelaySeconds,256*384);
});
test('consolidation sources neither inflate the ordinary queue nor extend its ETA', () => {
  const result = summarizeExitQueue({...input(), validators:[validator(1),validator(2,'1024000000000','300')], consolidations:[{source_index:'2',target_index:'9'}]});
  assert.equal(result.validators,1);
  assert.equal(result.effectiveETH,'32.0');
  assert.equal(result.lastExitAt,genesis+110*384);
  assert.equal(result.consolidationValidators,1);
  assert.equal(result.consolidationEffectiveETH,'1024.0');
});
test('slashed consolidation sources follow withdrawals, and are explicitly counted as slashed', () => {
  const result = summarizeExitQueue({...input(), validators:[validator(2,'31000000000','115',true)], consolidations:[{source_index:'2',target_index:'9'}]});
  assert.equal(result.validators,1);
  assert.equal(result.slashedValidators,1);
  assert.equal(result.consolidationValidators,0);
});
test('an empty observed queue has no invented exit ETA or immediate-new-exit claim', () => {
  const result = summarizeExitQueue(input());
  assert.equal(result.validators,0);
  assert.equal(result.effectiveETH,'0.0');
  assert.equal(result.lastExitAt,null);
});
test('rejects stale heads, incomplete lists, unfiltered validators and duplicate entries', () => {
  assert.throws(()=>summarizeExitQueue({...input(),fetchedAt:observed+181}));
  assert.throws(()=>summarizeExitQueue({...input(),consolidations:null}));
  assert.throws(()=>summarizeExitQueue({...input(),validators:[validator(1),validator(1)]}));
  assert.throws(()=>summarizeExitQueue({...input(),validators:[validator(1,'32000000000','100')]}));
  assert.throws(()=>summarizeExitQueue({...input(),validators:[validator(1,'32000000000','18446744073709551615')]}));
});

const genesisRoot = '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95';
function beaconFetch(changes = {}) {
  const calls = [];
  const fetcher = async url => {
    const path = new URL(url).pathname;
    calls.push(url);
    let data;
    if (path.endsWith('/genesis')) data={genesis_time:String(genesis),genesis_validators_root:genesisRoot};
    else if (path.endsWith('/spec')) data={DEPOSIT_CHAIN_ID:'1',SECONDS_PER_SLOT:'12',SLOTS_PER_EPOCH:'32',MIN_VALIDATOR_WITHDRAWABILITY_DELAY:'256'};
    else if (path.endsWith('/head')) data={canonical:true,header:{message:{slot:String(slot),state_root:root}}};
    else if (path.endsWith('/validators')) data=[validator(1)];
    else if (path.endsWith('/pending_consolidations')) data=[];
    else throw new Error('Unexpected unpinned request');
    const body = {data,execution_optimistic:false};
    return Response.json(changes[path]?.(body) ?? body);
  };
  return {fetcher,calls};
}
test('collector pins both lists to one verified state root and checks chain identity', async () => {
  const {fetcher,calls}=beaconFetch();
  const result=await collectExitQueue('mainnet',{endpoints:['https://test.invalid'],fetcher,now:()=>observed+10});
  assert.equal(result.validators,1);
  assert.equal(result.source.url,null);
  assert.ok(calls.some(u=>u.includes(`/states/${root}/validators?status=active_exiting,active_slashed`)));
  assert.ok(calls.some(u=>u.includes(`/states/${root}/pending_consolidations`)));
  await assert.rejects(collectExitQueue('hoodi',{endpoints:['https://test.invalid'],fetcher,now:()=>observed+10}),/unavailable/);
});
test('optimistic and incomplete snapshots fail closed rather than showing a zero queue', async () => {
  for (const changes of [
    {'/eth/v1/beacon/headers/head':body=>({...body,execution_optimistic:true})},
    {[`/eth/v1/beacon/states/${root}/pending_consolidations`]:()=>({execution_optimistic:false})},
  ]) {
    await assert.rejects(collectExitQueue('mainnet',{endpoints:['https://test.invalid'],fetcher:beaconFetch(changes).fetcher,now:()=>observed+10}),/unavailable/);
  }
});
test('cache deduplicates reads and never leaks Mainnet data into Hoodi', async () => {
  let calls=0;
  const read=createExitQueueReader(async network=>{calls++;return {...summarizeExitQueue(input()),network};},()=>observed+10);
  const [a,b]=await Promise.all([read('mainnet'),read('mainnet')]);
  assert.equal(calls,1);assert.deepEqual(a,b);
  assert.equal((await read('hoodi')).snapshot.network,'hoodi');
  assert.equal(calls,2);
});
test('failed refresh retains marked stale data only briefly, then reports unavailable', async () => {
  let now=observed+10,failed=false,calls=0;
  const read=createExitQueueReader(async()=>{calls++;if(failed)throw Error('down');return summarizeExitQueue(input());},()=>now);
  assert.equal((await read('mainnet')).status,'ready');
  failed=true;now+=61;
  const stale=await read('mainnet');
  assert.equal(stale.status,'stale');assert.equal(stale.snapshot.observedAt,observed);
  now=observed+901;
  const unavailable=await read('mainnet');
  assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.snapshot,null);
  const before=calls;
  await read('mainnet');
  assert.equal(calls,before,'unavailable responses are cached during the retry cooldown');
});
