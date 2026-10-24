import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, keccak256 } from 'ethers';
import { BUS, MIGRATOR, CONSOLIDATION_NETWORKS, applyConsolidationLogs, operatorCoverage, quotaAt, estimateBatch, unpackLimit } from '../app/consolidation-data.ts';
const cfg=CONSOLIDATION_NETWORKS.mainnet,coder=AbiCoder.defaultAbiCoder();
const pk=n=>'0x'+n.toString(16).padStart(96,'0');
const encoded=coder.encode(['tuple(bytes[] sourcePubkeys,bytes targetPubkey)[]'],[[{sourcePubkeys:[pk(1),pk(2)],targetPubkey:pk(3)}]]),hash=keccak256(encoded);
const log=(abi,event,args,block,index,tx=String(block))=>({...abi.encodeEventLog(abi.getEvent(event),args),address:abi===BUS?cfg.bus:cfg.migrator,blockNumber:'0x'+block.toString(16),logIndex:'0x'+index.toString(16),transactionHash:'0x'+tx.padStart(64,'0'),blockTimestamp:'0x'+(1000+block).toString(16)});
const publication=(block=10,indices=[5,6])=>[log(BUS,'RequestsAdded',[cfg.migrator,encoded],block,5),log(MIGRATOR,'ConsolidationSubmitted',[2,9,[[indices,4]]],block,6)];
const empty=()=>({batches:[],executions:[]});
test('replays oldest-first occurrences, attributes adjacent Migrator groups and reconciles execution',()=>{
  const h=applyConsolidationLogs(empty(),[log(BUS,'RequestsExecuted',[hash,123n],20,3),...publication().reverse()],'mainnet');
  assert.equal(h.batches.length,1);assert.equal(h.batches[0].sourceOperator,2);assert.equal(h.batches[0].targetOperator,9);assert.deepEqual(h.batches[0].groups[0].sourceIndices,[5,6]);assert.equal(h.batches[0].status,'executed');assert.equal(h.executions[0].count,2);assert.equal(h.executions[0].feeWei,'123');
});
test('resubmitted hashes remain separate occurrences and unique CMv1 coverage is not inflated',()=>{
  const h=applyConsolidationLogs(empty(),[...publication(10),log(BUS,'BatchesRemoved',[[hash]],11,1),...publication(12),log(BUS,'RequestsExecuted',[hash,100n],13,2),...publication(14)],'mainnet');
  assert.deepEqual(h.batches.map(b=>b.status),['removed','executed','pending']);
  const [o]=operatorCoverage(h.batches,[{id:2,name:'NO',deposited:10,exited:4}]);assert.equal(o.requested,2);assert.equal(o.percent,20);assert.equal(o.pending,2);assert.equal(o.executed,2);assert.equal(o.removed,2);
});
test('does not attribute a different publisher or a non-adjacent event to an operator',()=>{
  const events=publication();events[0]=log(BUS,'RequestsAdded',['0x0000000000000000000000000000000000000001',encoded],10,5);
  assert.equal(applyConsolidationLogs(empty(),events,'mainnet').batches[0].sourceOperator,null);
  const distant=publication();distant[1].logIndex='0x7';assert.equal(applyConsolidationLogs(empty(),distant,'mainnet').batches[0].sourceOperator,null);
});
test('replay rejects missing lifecycle history and malformed counts rather than claiming an empty queue',()=>{
  assert.throws(()=>applyConsolidationLogs(empty(),[log(BUS,'RequestsExecuted',[hash,1n],10,1)],'mainnet'),/no preceding/);
  assert.throws(()=>applyConsolidationLogs(empty(),publication(10,[1]),'mainnet'),/count mismatch/);
  const event=publication()[0];delete event.blockTimestamp;assert.throws(()=>applyConsolidationLogs(empty(),[event],'mainnet'),/timestamp/);
});
test('incremental checkpoint replay matches one-shot history and ignores removed reorg logs',()=>{
  const h=applyConsolidationLogs(empty(),publication(),'mainnet');applyConsolidationLogs(h,[...publication(),{...log(BUS,'BatchesRemoved',[[hash]],11,1),removed:true},log(BUS,'RequestsExecuted',[hash,1n],12,1)],'mainnet');
  const complete=applyConsolidationLogs(empty(),[...publication(),log(BUS,'RequestsExecuted',[hash,1n],12,1)],'mainnet');assert.deepEqual(h,complete);
});
test('CMv1 denominator is ever-deposited and rejects source indexes outside it',()=>{
  const h=applyConsolidationLogs(empty(),publication(),'mainnet');assert.equal(operatorCoverage(h.batches,[{id:2,name:'NO',deposited:20,exited:10}])[0].percent,10);
  assert.throws(()=>operatorCoverage(h.batches,[{id:2,name:'NO',deposited:5,exited:0}]),/exceeds/);
  assert.equal(operatorCoverage([],[{id:0,name:'Empty',deposited:0,exited:0}])[0].percent,null);
});
const limit={max:100,previous:10,previousTimestamp:1000,frameSeconds:30,perFrame:5,current:15,unlimited:false};
test('unpacks the exact Solidity uint32 rate limit storage layout',()=>{
  const packed=100n+(10n<<32n)+(1000n<<64n)+(30n<<96n)+(5n<<128n);assert.deepEqual(unpackLimit('0x'+packed.toString(16),15),limit);
});
test('quota restores at discrete frame boundaries and caps at max',()=>{
  assert.equal(quotaAt(limit,1029),10);assert.equal(quotaAt(limit,1030),15);assert.equal(quotaAt(limit,1059),15);assert.equal(quotaAt(limit,1060),20);assert.equal(quotaAt(limit,100000),100);
});
test('oldest batch ETA waits for both quota restoration and retroactive execution delay',()=>{
  const batch={addedAt:900,count:22};assert.equal(estimateBatch(batch,limit,0,1035).at,1090);assert.equal(estimateBatch(batch,limit,240,1035).at,1140);
  assert.equal(estimateBatch({addedAt:900,count:15},limit,0,1035).at,1035);
});
test('unlimited, frozen, oversized and paused cases never produce false execution dates',()=>{
  assert.equal(estimateBatch({addedAt:1000,count:1000},{...limit,max:0,unlimited:true},200,1100).at,1200);
  assert.equal(estimateBatch({addedAt:900,count:101},limit,0,1100).at,null);
  assert.match(estimateBatch({addedAt:900,count:20},{...limit,perFrame:0},0,1100).reason,/disabled/);
  assert.equal(estimateBatch({addedAt:900,count:1},limit,0,1100,['DSM paused']).at,null);
});
test('several batches in one execution transaction are aggregated and preserve log order',()=>{
  const secondEncoded=coder.encode(['tuple(bytes[] sourcePubkeys,bytes targetPubkey)[]'],[[{sourcePubkeys:[pk(7)],targetPubkey:pk(8)}]]),secondHash=keccak256(secondEncoded);
  const h=applyConsolidationLogs(empty(),[...publication(10),log(BUS,'RequestsAdded',[cfg.migrator,secondEncoded],10,7),log(MIGRATOR,'ConsolidationSubmitted',[3,10,[[[8],5]]],10,8),log(BUS,'RequestsExecuted',[hash,5n],12,10,'12'),log(BUS,'RequestsExecuted',[secondHash,7n],12,12,'12')],'mainnet');
  assert.deepEqual(h.batches.map(b=>b.sourceOperator),[2,3]);assert.equal(h.executions.length,1);assert.equal(h.executions[0].count,3);assert.equal(h.executions[0].feeWei,'12');assert.equal(h.executions[0].batches.length,2);
});
