import assert from 'node:assert/strict';
import test from 'node:test';
import { exampleScenario, simulateExits, validateScenario } from '../app/vebo-simulation.ts';
import { validPendingDeposit } from '../app/vebo-deposit-signature.ts';
const op=(id,index,count=10,extra={})=>({id:`1:${id}`,moduleId:1,name:`Operator ${id}`,validators:count,excluded:0,pending:0,balanceETH:32,credential:'0x01',weight:100,mode:'none',target:0,indexStart:index,...extra});
function scenario(operators,extra={}){return {...exampleScenario(),modules:[{id:1,name:'Curated',exitShareBps:10000}],operators,groups:[],reports:1,demandETH:32,availableETH:0,incomingETH:0,rewardsETH:0,depositLockETH:0,growthETH:0,maxRequests:500,maxExitETH:100000,...extra};}
test('lexicographic priority chooses force, soft, stake deviation, then lowest index',()=>{
 assert.equal(simulateExits(scenario([op(0,1,10),op(1,100,10,{mode:'soft',target:9})]))[0].steps[0].winner.operatorId,'1:1');
 assert.equal(simulateExits(scenario([op(0,1,10,{mode:'soft',target:0}),op(1,100,10,{mode:'force',target:9})]))[0].steps[0].winner.operatorId,'1:1');
 assert.equal(simulateExits(scenario([op(0,1,5),op(1,100,10)]))[0].steps[0].winner.operatorId,'1:1');
 assert.equal(simulateExits(scenario([op(0,100,10),op(1,1,10)]))[0].steps[0].winner.operatorId,'1:1');
});
test('forced exits continue without demand; soft exits do not',()=>{
 const r=simulateExits(scenario([op(0,1,10,{mode:'soft',target:0}),op(1,100,10,{mode:'force',target:7})],{demandETH:0}))[0];
 assert.equal(r.steps.length,3);assert.ok(r.steps.every(s=>s.phase==='forced'&&s.winner.operatorId==='1:1'));
 assert.equal(simulateExits(scenario([op(0,1,10,{mode:'soft',target:0})],{demandETH:0}))[0].steps.length,0);
});
test('zero withdrawal demand cannot trigger ordinary exits even with a negative funding estimate',()=>{
 assert.equal(simulateExits(scenario([op(0,1)],{demandETH:0,depositLockETH:100}))[0].steps.length,0);
});
test('ranking recalculates after each exit rather than draining one operator',()=>{
 const r=simulateExits(scenario([op(0,1),op(1,100)],{demandETH:128}))[0];
 assert.deepEqual(r.steps.map(s=>s.winner.operatorId),['1:0','1:1','1:0','1:1']);
 assert.equal(r.steps[0].criterion,4);assert.equal(r.steps[1].criterion,3);
});
test('changing weights changes the weighted target and the selected operator',()=>{
 const s=scenario([op(0,1),op(1,100)]);assert.equal(simulateExits(s)[0].steps[0].winner.operatorId,'1:0');
 s.operators[0].weight=1000;assert.equal(simulateExits(s)[0].steps[0].winner.operatorId,'1:1');
});
test('module exit share outranks operator deviation and recomputes across modules',()=>{
 const s=scenario([op(0,1,10),{...op(1,100,10),id:'3:1',moduleId:3}],{modules:[{id:1,name:'A',exitShareBps:9000},{id:3,name:'B',exitShareBps:1000}]});
 const first=simulateExits(s)[0].steps[0];assert.equal(first.winner.moduleId,3);assert.equal(first.criterion,2);
});
test('32/2048 sanity cap differs from predicted principal, and never skips an oversized winner',()=>{
 const s=scenario([op(0,1,1,{credential:'0x02',balanceETH:40}),op(1,100,1)],{maxExitETH:2047,demandETH:40});
 const r=simulateExits(s)[0];assert.equal(r.steps.length,0);assert.equal(r.stop,'sanity');assert.equal(r.blocked.validator.maxEffectiveETH,2048);
 s.maxExitETH=2048;const yes=simulateExits(s)[0];assert.equal(yes.steps.length,1);assert.equal(yes.exitETH,40);assert.equal(yes.budgetETH,2048);
});
test('count and ETH limits are inclusive, including zero budgets',()=>{
 const s=scenario([op(0,1)],{demandETH:1000,maxRequests:2,maxExitETH:64});
 assert.equal(simulateExits(s)[0].steps.length,2);
 assert.equal(simulateExits({...s,maxRequests:0})[0].steps.length,0);
 assert.equal(simulateExits({...s,maxExitETH:0})[0].stop,'sanity');
});
test('prior requests are not repeated and count as committed funding in later reports',()=>{
 const r=simulateExits(scenario([op(0,1)],{demandETH:128,maxRequests:2,reports:3}));
 assert.deepEqual(r.map(r=>r.steps.length),[2,2,0]);assert.deepEqual(r.flatMap(r=>r.steps.map(s=>s.winner.validator.index)),[1,2,3,4]);
 assert.deepEqual(r.map(r=>r.remainingETH),[64,0,0]);
});
test('new demand per frame is cumulative; it is not multiplied by already requested exits',()=>{
 const r=simulateExits(scenario([op(0,1)],{demandETH:32,growthETH:32,reports:3}));assert.deepEqual(r.map(r=>r.steps.length),[1,1,1]);
});
test('pending stake affects forced targets but pending and excluded validators cannot exit',()=>{
 const r=simulateExits(scenario([op(0,1,4,{excluded:2,pending:3,mode:'force',target:2})],{demandETH:0}))[0];
 assert.equal(r.steps.length,2);assert.equal(r.steps[0].winner.force,3);assert.equal(r.steps[1].winner.force,2);
});
test('individual balances, caps, and indexes override aggregate defaults',()=>{
 const r=simulateExits(scenario([op(0,999,2,{validatorData:[{index:20,balanceETH:10,maxEffectiveETH:2048},{index:10,balanceETH:16,maxEffectiveETH:32}]})],{demandETH:26,maxExitETH:2080}))[0];
 assert.deepEqual(r.steps.map(s=>s.winner.validator.index),[10,20]);assert.equal(r.exitETH,26);assert.equal(r.budgetETH,2080);
});
test('real public keys survive validation, sorting, edits and JSON export/import',()=>{
 const keyA='0x'+'ab'.repeat(48),keyB='0x'+'cd'.repeat(48);
 const s=scenario([op(0,999,2,{validatorData:[{index:20,pubkey:keyB,balanceETH:32,maxEffectiveETH:32},{index:10,pubkey:keyA,balanceETH:32,maxEffectiveETH:32}]})],{demandETH:64});
 const imported=validateScenario(JSON.parse(JSON.stringify(s)));
 imported.operators[0].weight=12345;
 imported.operators[0].mode='force';imported.operators[0].target=0;
 const selected=simulateExits(imported)[0].steps.map(step=>step.winner.validator);
 assert.deepEqual(selected.map(v=>[v.index,v.pubkey]),[[10,keyA],[20,keyB]]);
});
test('rejects malformed or repeated public keys across different validator indexes',()=>{
 const key='0x'+'ab'.repeat(48);
 const pool=pubkey=>[{index:10,pubkey,balanceETH:32,maxEffectiveETH:32}];
 assert.throws(()=>validateScenario(scenario([op(0,0,1,{validatorData:pool('0x1234')})])),/public key/);
 assert.throws(()=>validateScenario(scenario([op(0,0,1,{validatorData:pool(key)}),op(1,0,1,{validatorData:[{...pool(key.toUpperCase().replace('0X','0x'))[0],index:20}]})])),/Duplicate validator public key/);
});
test('MetaRegistry linked stake and weight shift both sides of the group',()=>{
 const s=scenario([op(0,1,10),op(1,100,10),{...op(0,200,2),id:'4:0',moduleId:4,weight:100}],{modules:[{id:1,name:'CM1',exitShareBps:10000},{id:4,name:'CM2',exitShareBps:10000}],groups:[{name:'linked',external:['1:0'],internal:[{operatorId:'4:0',shareBps:10000}]}],demandETH:64});
 const r=simulateExits(s)[0];assert.equal(r.steps[0].winner.operatorId,'1:0');assert.equal(r.steps[0].winner.stakeETH,384);assert.equal(r.steps[0].winner.targetStakeETH,352);
 assert.equal(r.steps[1].winner.operatorId,'1:0');assert.equal(r.steps[1].winner.stakeETH,352);
});
test('no eligible validators reports exhaustion instead of fabricating an exit',()=>{
 const r=simulateExits(scenario([op(0,1,0)]))[0];assert.equal(r.stop,'exhausted');assert.equal(r.remainingETH,32);
});
test('scenario validation rejects ambiguous validator indexes and invalid groups',()=>{
 assert.throws(()=>validateScenario(scenario([op(0,1),op(1,5)])),/overlap/);
 assert.throws(()=>validateScenario(scenario([op(0,1)],{maxRequests:2.5})),/integer/);
 assert.throws(()=>validateScenario(scenario([op(0,1)],{groups:[{name:'bad',external:['9:9'],internal:[]}]})),/Unknown/);
 assert.throws(()=>validateScenario(scenario([op(0,1,1,{validatorData:[{index:1,balanceETH:33,maxEffectiveETH:32}]})])),/balance/);
 assert.doesNotThrow(()=>validateScenario(exampleScenario()));
});
test('BLS pending deposits preserve the pre-upgrade Ethereum POP signature vector',()=>{
 // Generated with noble-curves 1.2.0 before the v2 migration (public test key 123).
 const d={"pubkey":"0xa0ec3e71a719a25208adc97106b122809210faf45a17db24f10ffb1ac014fac1ab95a4a1967e55b185d4df622685b9e8","withdrawal_credentials":"0x0100000000000000000000000000000000000000000000000000000000000000","amount":"32000000000","signature":"0x9397122d755e473aac5a4bbe1406a24b999f0a3f23e5ba33a433769eeda13e40febe63382a17d41097d3b8eb48cbde7b01f3d9b82cbb71c416f22f96405e56670db71916b9a45a7503ac2aa9e7b771eb62790c6a6a9577b74d27b915f22f2878"};
 assert.equal(validPendingDeposit(d,'0x00000000'),true);
 assert.equal(validPendingDeposit({...d,amount:'32000000001'},'0x00000000'),false);
 assert.equal(validPendingDeposit(d,'0x10000910'),false);
 assert.equal(validPendingDeposit({...d,signature:'0x'+'00'.repeat(96)},'0x00000000'),false);
 assert.equal(validPendingDeposit({...d,pubkey:'0x'+'00'.repeat(48)},'0x00000000'),false);
});

test('removed empty MetaRegistry group slots do not invalidate or alter selection',()=>{
 const s=scenario([op(0,1)]);const expected=simulateExits(s);s.groups.push({name:'',external:[],internal:[]});assert.doesNotThrow(()=>validateScenario(s));assert.deepEqual(simulateExits(s),expected);
});
