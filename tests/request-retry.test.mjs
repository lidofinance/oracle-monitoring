import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchWithRetry,recoveryDelay,requestRetryDelay,waitForRetry} from '../app/request-retry.ts';
const input='https://monitor.test/api/depositor?network=mainnet';
test('temporary HTTP and network errors recover with bounded backoff and preserve the selected RPC',async()=>{
 let calls=0;const delays=[];
 const result=await fetchWithRetry(input,{headers:{'x-lido-rpc':'publicnode'}},{fetcher:async(_,init)=>{
  calls++;assert.equal(new Headers(init.headers).get('x-lido-rpc'),'publicnode');
  if(calls===1)throw new TypeError('Network disconnected');if(calls===2)return Response.json({error:'temporarily unavailable'},{status:503});return Response.json({ok:true});
 },sleep:async delay=>{delays.push(delay);},random:()=>0});
 assert.deepEqual(await result.json(),{ok:true});assert.equal(calls,3);assert.deepEqual(delays,[1000,2000]);
});
test('rate limits honor Retry-After, including HTTP dates',async()=>{
 let calls=0;const delays=[];
 await fetchWithRetry(input,{}, {fetcher:async()=>++calls===1?new Response('',{status:429,headers:{'retry-after':'5'}}):new Response('ok'),sleep:async ms=>{delays.push(ms);},random:()=>0});
 assert.deepEqual(delays,[5000]);assert.equal(requestRetryDelay(0,'Thu, 01 Jan 1970 00:00:06 GMT',1000,0),5000);
});
test('validation and authorization errors and writes are never automatically replayed',async()=>{
 for(const [status,method] of [[400,'GET'],[401,'GET'],[403,'GET'],[404,'GET'],[503,'POST']]){
  let calls=0;const result=await fetchWithRetry(input,{method},{fetcher:async()=>{calls++;return Response.json({error:'not retried'},{status});},sleep:async()=>assert.fail('must not wait')});
  assert.equal(result.status,status);assert.equal(calls,1);
 }
});
test('cancellation during backoff stops all later requests',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(fetchWithRetry(input,{signal:controller.signal},{fetcher:async()=>{calls++;return new Response('',{status:502});},sleep:async()=>{controller.abort();},random:()=>0}),{name:'AbortError'});
 assert.equal(calls,1);
 const already=new AbortController();already.abort();await assert.rejects(waitForRetry(1000,already.signal),{name:'AbortError'});
});
test('exhausted attempts return the last readable error without an infinite loop',async()=>{
 let calls=0;const result=await fetchWithRetry(input,{}, {fetcher:async()=>{calls++;return Response.json({error:'still down'},{status:504});},sleep:async()=>{},random:()=>0});
 assert.equal(calls,4);assert.deepEqual(await result.json(),{error:'still down'});
 assert.deepEqual([0,1,2,3,10].map(recoveryDelay),[600000,1200000,2400000,4800000,4800000]);
});
