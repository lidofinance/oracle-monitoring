import assert from 'node:assert/strict';
import test from 'node:test';
import {createRpcReader, RpcReadError} from '../app/rpc-read.ts';

function clock(){let time=0;return {now:()=>time,sleep:async ms=>{time+=ms;}};}
const response=result=>Response.json({jsonrpc:'2.0',id:1,result});

test('concurrent reads share a paced queue and at most two in-flight requests per endpoint',async()=>{
 const timing=clock(),starts=[];let active=0,peak=0;
 const read=createRpcReader({...timing,fetcher:async()=>{starts.push(timing.now());active++;peak=Math.max(peak,active);await Promise.resolve();active--;return response('0x1');}});
 assert.deepEqual(await Promise.all(Array.from({length:6},()=>read(['primary'],'eth_chainId',[]))),Array(6).fill('0x1'));
 assert.ok(peak<=2);
 for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=250);
});

test('429 and JSON-RPC rate limits recover without changing a selected provider',async()=>{
 for(const first of [()=>Response.json({error:{message:'rate limit exceeded'}},{status:429,headers:{'retry-after':'2'}}),()=>Response.json({error:{code:-32005,message:'rate limit exceeded'}})]){
  const timing=clock(),starts=[],urls=[];let calls=0;
  const read=createRpcReader({...timing,fetcher:async(url)=>{urls.push(url);starts.push(timing.now());return ++calls===1?first():response('0x0');}});
  assert.equal(await read(['selected'],'eth_getBalance',['wallet','latest']),'0x0');
  assert.equal(calls,2);assert.deepEqual([...new Set(urls)],['selected']);assert.ok(starts[1]-starts[0]>=1000);
 }
});

test('Auto can fall back, while deterministic contract errors do not trigger retry storms',async()=>{
 const timing=clock(),urls=[];
 const read=createRpcReader({...timing,fetcher:async url=>{urls.push(url);return url==='bad'?Response.json({error:{code:3,message:'execution reverted'}}):response('0x2');}});
 assert.equal(await read(['bad','good'],'eth_call',[]),'0x2');assert.deepEqual(urls,['bad','good']);
 urls.length=0;
 await assert.rejects(read(['bad'],'eth_call',[]),error=>error instanceof RpcReadError&&error.reason==='rpc');
 assert.deepEqual(urls,['bad']);
});

test('exhausted rate limits are bounded and request errors never expose endpoint credentials',async()=>{
 const timing=clock();let calls=0;
 const read=createRpcReader({...timing,fetcher:async()=>{calls++;return new Response('',{status:429});}});
 await assert.rejects(read(['https://secret.invalid/key'],'eth_call',[]),error=>error.reason==='rate-limit'&&!error.message.includes('secret'));
 assert.equal(calls,3);
 await assert.rejects(read(['selected'],'eth_sendRawTransaction',[]),/Only Ethereum reads/);
 assert.equal(calls,3);
});
