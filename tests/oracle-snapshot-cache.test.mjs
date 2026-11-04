import assert from 'node:assert/strict';
import test from 'node:test';
import {compactOracleMessages,createOracleSnapshotCache} from '../app/oracle-snapshot-cache.ts';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('concurrent visitors share one collection and receive partial membership before telemetry',async()=>{
 let progress,finish,calls=0;const cache=createOracleSnapshotCache(()=>1000);
 const collect=async report=>{calls++;progress=report;return new Promise(resolve=>{finish=resolve;});};
 const first=cache.read('auto:auto:overview',collect),second=cache.read('auto:auto:overview',collect);
 await tick();assert.equal(calls,1);assert.equal(first,second);assert.equal(first.status,'loading');
 progress({mainnet:{members:['member'],telemetryLoading:true}});
 assert.deepEqual(first.snapshot.mainnet.members,['member']);assert.equal(first.status,'loading');
 finish({mainnet:{members:['member'],telemetryLoading:false}});await tick();assert.equal(first.status,'ready');
 assert.equal(cache.read('auto:auto:overview',collect),first);assert.equal(calls,1);
});
test('ten-minute expiry and source/mode keys prevent reuse across RPC choices or ledger modes',async()=>{
 let now=1000,calls=0;const cache=createOracleSnapshotCache(()=>now),collect=async()=>{calls++;return {};};
 const first=cache.read('mainnet:auto:hoodi:auto:overview',collect);await tick();
 now+=599999;assert.equal(cache.read('mainnet:auto:hoodi:auto:overview',collect),first);assert.equal(calls,1);
 cache.read('mainnet:publicnode:hoodi:auto:overview',collect);cache.read('mainnet:auto:hoodi:drpc:overview',collect);cache.read('mainnet:auto:hoodi:auto:telemetry',collect);await tick();assert.equal(calls,4);
 now++;assert.notEqual(cache.read('mainnet:auto:hoodi:auto:overview',collect),first);await tick();assert.equal(calls,5);
});
test('failed jobs retain partial state and cannot trigger a polling retry storm',async()=>{
 let calls=0;const cache=createOracleSnapshotCache(()=>1000);
 const collect=async report=>{calls++;report({mainnet:{members:['known']}});throw Error('RPC down');};
 const first=cache.read('key',collect);await tick();assert.equal(first.status,'error');assert.deepEqual(first.snapshot.mainnet.members,['known']);
 for(let i=0;i<5;i++)assert.equal(cache.read('key',collect),first);
 assert.equal(calls,1);
});
test('compact overview preserves readiness and startup even when a newer report exists',()=>{
 const message=(block,event,module='csm',memberAddress='member')=>({blockNumber:block,event,module,memberAddress,sender:memberAddress,transactionHash:`tx-${block}`});
 const data=compactOracleMessages([message(2,'diagnostic'),message(3,'startup'),message(4,'report'),message(1,'diagnostic'),message(5,'startup'),message(6,'diagnostic','cm'),message(7,'report','csm','other')]);
 assert.deepEqual(data.map(m=>m.blockNumber),[7,6,5,4,2]);
});
