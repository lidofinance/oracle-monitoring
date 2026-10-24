import assert from 'node:assert/strict';
import test from 'node:test';
import { sumLidoExitBalances } from '../app/lido-exit-balances-data.ts';
const key=n=>'0x'+n.toString(16).padStart(96,'0');
const record=(index,balance,status='active_exiting',exit='110')=>({index:String(index),balance:String(balance),status,validator:{pubkey:key(index),exit_epoch:exit}});

test('sums actual Lido balances across exiting and post-exit withdrawal stages, including rewards',()=>{
 const records=[record(1,'32123000001'),record(2,'20500000000','exited_unslashed','99'),record(3,'250000000','withdrawal_possible','90'),record(4,'99000000000')];
 const result=sumLidoExitBalances(records,new Set([key(1),key(2),key(3)]),[],100);
 assert.deepEqual(result,{balance:'52.873000001',validators:3});
});
test('excludes pending consolidation sources and non-Lido keys even when they have large balances',()=>{
 const records=[record(1,'40000000000'),record(2,'2048000000000'),record(3,'32000000000')];
 const result=sumLidoExitBalances(records,new Set([key(1),key(2)]),[{source_index:'2',target_index:'9'}],100);
 assert.deepEqual(result,{balance:'40.0',validators:1});
});
test('counts a slashed ordinary exit, but ignores zero balances and all consolidation sources',()=>{
 const records=[record(1,'31000000000','active_slashed'),record(2,'0','withdrawal_possible','90'),record(3,'30000000000','exited_slashed','99')];
 assert.deepEqual(sumLidoExitBalances(records,new Set([key(1),key(2),key(3)]),[{source_index:'3',target_index:'9'}],100),{balance:'31.0',validators:1});
});
test('confirmed empty states yield zero; malformed, duplicated or non-exiting records fail closed',()=>{
 assert.deepEqual(sumLidoExitBalances([],new Set(),[],100),{balance:'0.0',validators:0});
 assert.throws(()=>sumLidoExitBalances(null,new Set(),[],100));
 assert.throws(()=>sumLidoExitBalances([record(1,'32000000000'),record(1,'32000000000')],new Set([key(1)]),[],100));
 assert.throws(()=>sumLidoExitBalances([record(1,'32000000000','active_ongoing','18446744073709551615')],new Set([key(1)]),[],100));
 assert.throws(()=>sumLidoExitBalances([record(1,'32000000000','withdrawal_possible','110')],new Set([key(1)]),[],100));
});
