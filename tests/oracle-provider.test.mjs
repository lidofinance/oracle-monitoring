import assert from 'node:assert/strict';
import test from 'node:test';
import {Contract, Interface} from 'ethers';
import {OracleReadProvider} from '../app/oracle-provider.ts';
import {readConsensusFrame} from '../app/oracle-consensus.ts';

function timing(){let now=0;return{now:()=>now,sleep:async ms=>{now+=ms;}};}
const result=value=>Response.json({jsonrpc:'2.0',id:1,result:value});

test('Auto recovers from a non-JSON contract response after a successful initial connection',async()=>{
 const calls=[],abi=new Interface(['function getFrameConfig() view returns(uint256,uint256,uint256)']);
 const provider=new OracleReadProvider(['primary','backup'],1,{...timing(),fetcher:async(url,init)=>{
  const {method}=JSON.parse(init.body);calls.push({url,method});
  if(method==='eth_chainId')return result('0x1');
  if(method==='eth_blockNumber')return result('0x64');
  if(method==='eth_call')return url==='primary'?new Response('<html>upstream error</html>'):result(abi.encodeFunctionResult('getFrameConfig',[1,6300,0]));
  throw Error(method);
 }});
 try{
  assert.equal(await provider.getBlockNumber(),100);
  const contract=new Contract('0x'+'11'.repeat(20),abi,provider);
  assert.equal((await contract.getFrameConfig())[1],6300n);
  assert.ok(calls.some(c=>c.url==='backup'&&c.method==='eth_call'));
  assert.equal(calls.find(c=>c.url==='backup').method,'eth_chainId');
 }finally{provider.destroy();}
});

test('initial-epoch custom errors preserve their revert data through the retry transport',async()=>{
 const provider=new OracleReadProvider(['selected'],1,{...timing(),fetcher:async(_,init)=>{
  const {method}=JSON.parse(init.body);
  return method==='eth_chainId'?result('0x1'):Response.json({error:{code:3,message:'execution reverted',data:'0xcd0883ea'}});
 }});
 try{
  const contract=new Contract('0x'+'22'.repeat(20),['function getCurrentFrame() view returns(uint256,uint256)'],provider);
  assert.equal(await readConsensusFrame(()=>contract.getCurrentFrame()),null);
 }finally{provider.destroy();}
});

test('explicit sources retry malformed replies without switching providers',async()=>{
 let attempts=0;const urls=[];
 const provider=new OracleReadProvider(['selected'],1,{...timing(),fetcher:async(url,init)=>{
  urls.push(url);const {method}=JSON.parse(init.body);
  if(method==='eth_chainId')return result('0x1');
  return ++attempts===1?new Response('temporarily unavailable'):result('0x65');
 }});
 try{assert.equal(await provider.getBlockNumber(),101);assert.equal(attempts,2);assert.deepEqual([...new Set(urls)],['selected']);}
 finally{provider.destroy();}
});

test('each fallback endpoint must match the requested chain before supplying data',async()=>{
 const calls=[];
 const provider=new OracleReadProvider(['wrong','correct'],1,{...timing(),fetcher:async(url,init)=>{
  const {method}=JSON.parse(init.body);calls.push({url,method});
  return result(method==='eth_chainId'?(url==='wrong'?'0x88bb0':'0x1'):'0x66');
 }});
 try{assert.equal(await provider.getBlockNumber(),102);assert.ok(calls.filter(c=>c.url==='wrong').every(c=>c.method==='eth_chainId'));}
 finally{provider.destroy();}
});
