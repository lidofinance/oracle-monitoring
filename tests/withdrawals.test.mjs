import assert from 'node:assert/strict';
import test from 'node:test';
import {withdrawalDays} from '../app/withdrawals-data.ts';
const day=1792713600;
const event=(timestamp,amount,requests)=>({timestamp,amount,requests});
test('withdrawal calendar bins include exact UTC boundaries once and exclude older events',()=>{
 const days=withdrawalDays([event(day,'4.5',2),event(day-1,'2',1),event(day-6*86400-1,'100',99)],day+3600);
 assert.equal(days.length,7);assert.equal(days[6].eth,4.5);assert.equal(days[5].eth,2);
 assert.equal(days.reduce((sum,d)=>sum+d.eth,0),6.5);assert.equal(days.reduce((sum,d)=>sum+d.requests,0),3);
});
test('multiple finalization events sum ETH, request counts and report counts in the same day',()=>{
 const last=withdrawalDays([event(day+1,'10',3),event(day+50,'1.25',1)],day+100).at(-1);
 assert.deepEqual(last,{timestamp:day,eth:11.25,requests:4,reports:2});
});
test('a complete empty calendar still returns seven explicit zero days',()=>{
 const days=withdrawalDays([],day);assert.equal(days.length,7);assert.ok(days.every(d=>d.eth===0&&d.requests===0&&d.reports===0));
});
