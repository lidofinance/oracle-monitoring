import assert from 'node:assert/strict';
import test from 'node:test';
import {beaconStateLayout,parseBeaconStatePrefix,newExitEpoch,scanActiveValidatorRegistry,activeValidatorSweepSeconds,vaultInflow} from '../app/exit-withdrawal-forecast-data.ts';
const spec={SLOTS_PER_HISTORICAL_ROOT:'8192',EPOCHS_PER_HISTORICAL_VECTOR:'65536',EPOCHS_PER_SLASHINGS_VECTOR:'8192',SYNC_COMMITTEE_SIZE:'512',MIN_SEED_LOOKAHEAD:'1',SLOTS_PER_EPOCH:'32'};
const expected={slot:15496908,genesisTime:1606824023,genesisRoot:'0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95'};
function fixture(version='fulu'){
  const {offsets:o,size}=beaconStateLayout(spec,version),bytes=new Uint8Array(size),view=new DataView(bytes.buffer);
  const set=(name,value)=>view.setBigUint64(o[name],BigInt(value),true);
  set('genesis',expected.genesisTime);set('slot',expected.slot);set('cursor',1234);set('earliestExit',484306);set('exitBalance',115073510636);
  bytes.set(Buffer.from(expected.genesisRoot.slice(2),'hex'),o.genesisRoot);
  let start=size;
  for(const name of ['historicalRoots','eth1Votes','validators','balances','previousParticipation','participation','inactivity','payload','summaries','pendingDeposits','pendingPartial','pendingConsolidation']){
    view.setUint32(o[name],start,true);
    if(name==='validators')start+=2000*121;
    if(name==='balances')start+=2000*8;
  }
  return {bytes,o,view};
}
test('decodes the Electra/Fulu fixed section without downloading validator records',()=>{
  // Mainnet fixed sizes independently checked against the live Beacon SSZ prefix.
  assert.equal(beaconStateLayout(spec,'electra').size,2736713);
  assert.equal(beaconStateLayout(spec,'fulu').size,2737225);
  for(const fork of ['electra','fulu']){
    const result=parseBeaconStatePrefix(fixture(fork).bytes,spec,fork,expected);
    assert.deepEqual(result,{validators:2000,cursor:1234,earliestExitEpoch:484306,exitBalanceToConsume:115073510636n});
  }
});
test('rejects wrong forks, networks, slots and incomplete or inconsistent SSZ layouts',()=>{
  const f=fixture();
  assert.throws(()=>parseBeaconStatePrefix(f.bytes,spec,'gloas',expected));
  assert.throws(()=>parseBeaconStatePrefix(f.bytes.subarray(0,100),spec,'fulu',expected));
  assert.throws(()=>parseBeaconStatePrefix(f.bytes,spec,'fulu',{...expected,slot:1}));
  assert.throws(()=>parseBeaconStatePrefix(f.bytes,spec,'fulu',{...expected,genesisRoot:'0x'+'00'.repeat(32)}));
  f.view.setUint32(f.o.balances,f.view.getUint32(f.o.balances,true)+1,true);
  assert.throws(()=>parseBeaconStatePrefix(f.bytes,spec,'fulu',expected));
});
test('new 32 ETH exit respects fresh protocol scheduling and a shared future exit/partial-withdrawal tail',()=>{
  assert.equal(newExitEpoch(100,99,0n,4),105,'old capacity resets at the protocol minimum');
  assert.equal(newExitEpoch(100,140,32_000_000_000n,4),140,'exact remaining capacity fits');
  assert.equal(newExitEpoch(100,140,31_999_999_999n,4),141,'one Gwei short pushes the exit to the next epoch');
  assert.equal(newExitEpoch(100,105,0n,4),106,'capacity is not reset when earliest epoch already equals minimum');
});
test('active-set sweep model uses payload capacity and ignores historical registry size',()=>{
  assert.equal(activeValidatorSweepSeconds({activeValidators:810792,withdrawalsPerPayload:16,secondsPerSlot:12}),608100);
  assert.equal(activeValidatorSweepSeconds({activeValidators:17,withdrawalsPerPayload:16,secondsPerSlot:12}),24,'a partial payload still takes a full slot');
  assert.throws(()=>activeValidatorSweepSeconds({activeValidators:0,withdrawalsPerPayload:16,secondsPerSlot:12}));
  assert.throws(()=>activeValidatorSweepSeconds({activeValidators:17,withdrawalsPerPayload:0,secondsPerSlot:12}));
});
test('streamed SSZ count handles record and chunk boundaries, active exits and activation at snapshot epoch',async()=>{
  const before=13,records=[[99n,101n],[100n,101n],[101n,200n],[99n,100n],[99n,0xffffffffffffffffn]];
  const bytes=new Uint8Array(before+records.length*121+7),view=new DataView(bytes.buffer);
  records.forEach(([activation,exit],i)=>{const at=before+i*121;view.setBigUint64(at+97,activation,true);view.setBigUint64(at+105,exit,true);});
  for(const size of [1,120,121,128,4096]){
    async function* chunks(){for(let at=0;at<bytes.length;at+=size)yield bytes.subarray(at,at+size);}
    assert.equal(await scanActiveValidatorRegistry(chunks(),{from:before,validators:records.length,epoch:100}),3);
  }
  async function* truncated(){yield bytes.subarray(0,bytes.length-8);}
  await assert.rejects(scanActiveValidatorRegistry(truncated(),{from:before,validators:records.length,epoch:100}),/Truncated/);
});
test('vault arrivals include ETH collected by Lido without double counting vault transfers',()=>{
  assert.equal(vaultInflow(100n,30n,170n),100n);
  assert.equal(vaultInflow(100n,150n,0n),50n);
  assert.equal(vaultInflow(100n,0n,100n),0n,'an oracle collection alone is not new income');
  assert.throws(()=>vaultInflow(100n,0n,99n),'incomplete accounting must never become zero income');
});
