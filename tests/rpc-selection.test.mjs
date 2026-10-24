import assert from 'node:assert/strict';
import test from 'node:test';
import { RPC_OPTIONS, parseRpcChoice } from '../app/rpc-selection.ts';
import { withRpcSelection, serverRpcs, rpcCacheKey } from '../app/rpc-server.ts';
const request=(network,id)=>new Request(`https://monitor.test/api/depositor?network=${network}`,{headers:id?{'x-lido-rpc':id}:{}});
test('RPC preferences migrate the old PublicNode alias and only accept presets belonging to the network',()=>{
 assert.deepEqual(parseRpcChoice(JSON.stringify({mainnet:'https://ethereum.publicnode.com',hoodi:RPC_OPTIONS.hoodi[0].url})),{mainnet:RPC_OPTIONS.mainnet[0].url,hoodi:RPC_OPTIONS.hoodi[0].url});
 assert.deepEqual(parseRpcChoice(JSON.stringify({mainnet:'http://127.0.0.1/private',hoodi:RPC_OPTIONS.mainnet[0].url})),{});
 assert.deepEqual(parseRpcChoice('null'),{});
});
test('unknown RPCs are rejected before the handler runs, without permitting arbitrary destinations',async()=>{
 let called=false;
 for(const id of ['http://127.0.0.1','../mevblocker','unknown']){
  const result=await withRpcSelection(request('mainnet',id),async()=>{called=true;return Response.json({});});
  assert.equal(result.status,400);
 }
 assert.equal(called,false);
});
test('parallel request scopes isolate selected providers, chains and cache keys',async()=>{
 const defaults=serverRpcs('hoodi');
 const results=await Promise.all(['publicnode','mevblocker'].map(id=>withRpcSelection(request('mainnet',id),async()=>{
  await new Promise(resolve=>setTimeout(resolve,id==='publicnode'?10:1));
  assert.deepEqual(serverRpcs('hoodi'),defaults);
  assert.equal(rpcCacheKey('hoodi'),'hoodi');
  return Response.json({urls:serverRpcs('mainnet'),key:rpcCacheKey('mainnet')},{headers:{'Cache-Control':'public,max-age=60',Vary:'Accept'}});
 })));
 for(let i=0;i<results.length;i++){
  const result=results[i],option=RPC_OPTIONS.mainnet.find(option=>option.id===['publicnode','mevblocker'][i]);
  assert.deepEqual(await result.json(),{urls:[option.url],key:`mainnet-rpc-${option.id}`});
  assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal(result.headers.get('vary'),'Accept, x-lido-rpc');
 }
 assert.equal(rpcCacheKey('mainnet'),'mainnet');
});
test('a collector retains its selected RPC after the polling response has returned',async()=>{
 let resume,background;
 const gate=new Promise(resolve=>{resume=resolve;});
 await withRpcSelection(request('hoodi','ethpandaops'),async()=>{
  background=gate.then(()=>({key:rpcCacheKey('hoodi'),urls:serverRpcs('hoodi')}));
  return Response.json({status:'loading'});
 });
 resume();
 assert.deepEqual(await background,{key:'hoodi-rpc-ethpandaops',urls:[RPC_OPTIONS.hoodi.find(option=>option.id==='ethpandaops').url]});
});
