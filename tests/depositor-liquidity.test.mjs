import assert from 'node:assert/strict';
import test from 'node:test';
import { REWARD_REPORT_ABI as abi, clRewardRate, liquidityModel } from '../app/depositor-liquidity-data.ts';
const event=(name,args,tx='0xabc')=>({transactionHash:tx,...abi.encodeEventLog(abi.getEvent(name),args)});
const report=(pre,post,withdrawn,el=0n,tx='0xabc',timestamp=100n,elapsed=86400n)=>[
 event('ETHDistributed',[timestamp,pre,post,withdrawn,el,0n],tx),
 event('TokenRebased',[timestamp,elapsed,1n,1n,1n,1n,0n],tx),
];
const wei=n=>BigInt(n)*10n**18n;
test('CL reward projection cancels returned exit principal and excludes EL rewards',()=>{
 const rate=clRewardRate(report(wei(1000),wei(903),wei(100),wei(5)));
 assert.equal(rate.dailyCLETH,3);assert.equal(rate.netCLETH,'3.0');assert.equal(rate.reports,1);
});
test('CL rewards use report elapsed time rather than the number of calendar days',()=>{
 const rate=clRewardRate([...report(wei(1000),wei(1002),0n,0n,'0x1',100n,43200n),...report(wei(1000),wei(1004),0n,0n,'0x2',200n,86400n)]);
 assert.equal(rate.dailyCLETH,4);assert.equal(rate.seconds,129600);
 assert.equal(clRewardRate(report(wei(1000),wei(999),0n)).dailyCLETH,0,'losses must not become positive rewards');
});
test('missing, duplicated or mismatched accounting events leave the reward rate unavailable',()=>{
 const logs=report(wei(1000),wei(1001),0n);
 assert.throws(()=>clRewardRate([]));assert.throws(()=>clRewardRate(logs.slice(0,1)));
 assert.throws(()=>clRewardRate([...logs,logs[0]]));
 assert.throws(()=>clRewardRate([logs[0],event('TokenRebased',[101n,86400n,1n,1n,1n,1n,0n])]));
});
const snapshot=()=>({network:'mainnet',timestamp:1000000,slot:1,block:1,bufferETH:'100',demandETH:'150',currentDepositLockETH:'10',depositTargetETH:'2000',maxWithdrawalETH:'1000',accountingFrameSeconds:86400,withdrawalVaultETH:'5',elVaultETH:'2',exits:[]});
test('deposit lock counts current reserve and only complete future frames, capped and halved',()=>{
 assert.equal(liquidityModel(snapshot(),86399,100,0,0).depositLockETH,10);
 const result=liquidityModel(snapshot(),2*86400,100,0,0);
 assert.equal(result.futureDepositLockETH,1000);assert.equal(result.depositLockETH,1010);assert.equal(result.requiredETH,1160);
 assert.equal(liquidityModel({...snapshot(),depositTargetETH:'100'},86400,100,0,0).futureDepositLockETH,50);
});
test('count capped exit balance and its known reward excess once, within the same horizon',()=>{
 const s=snapshot();s.exits=[
 {index:1,balanceETH:'33',cappedETH:'32',excessETH:'1',withdrawableAt:s.timestamp-100},
 {index:2,balanceETH:'32',cappedETH:'32',excessETH:'0',withdrawableAt:s.timestamp+86400},
 ];
 const result=liquidityModel(s,86400,3600,3,2);
 assert.equal(result.exitETH,32);assert.equal(result.clETH,4);assert.equal(result.elETH,2);
 assert.equal(result.exits,1);assert.equal(result.totalExits,2);assert.equal(result.incomingETH,145);
 assert.equal(result.netETH,145-result.requiredETH);
});
test('existing vault balances and buffer are not multiplied by the forecast duration',()=>{
 const s={...snapshot(),depositTargetETH:'0'};
 const result=liquidityModel(s,3*86400,3600,3,2);
 assert.equal(result.incomingETH,122);assert.equal(result.requiredETH,160);assert.equal(result.netETH,-38);
});
test('invalid model inputs cannot turn incomplete data into a surplus',()=>{
 assert.throws(()=>liquidityModel(snapshot(),NaN,3600,3,2));
 assert.throws(()=>liquidityModel({...snapshot(),bufferETH:'bad'},86400,3600,3,2));
 assert.throws(()=>liquidityModel({...snapshot(),exits:[{cappedETH:'bad',excessETH:'0',withdrawableAt:0}]},86400,3600,3,2));
});
