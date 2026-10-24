import { Interface, formatEther } from "ethers";
import { promises as fs } from "node:fs";
import path from "node:path";
import routerAbi from "./vebo-stakingrouter-abi";
import { serverRpcs, rpcCacheKey } from "./rpc-server";
import { BUS, MIGRATOR, GATEWAY, CONSOLIDATION_NETWORKS, applyConsolidationLogs, unpackLimit, quotaAt, operatorCoverage, type ConsolidationHistory, type ConsolidationNetwork, type ConsolidationSnapshot, type ChainLog } from "./consolidation-data";

const hex=(n:number)=>`0x${n.toString(16)}`;
const num=(n:string|bigint)=>Number(BigInt(n));
const router=new Interface(routerAbi);
const locator=new Interface(["function depositSecurityModule() view returns(address)","function lido() view returns(address)","function withdrawalVault() view returns(address)"]);
const pauseAbi=new Interface(["function isDepositsPaused() view returns(bool)","function canDeposit() view returns(bool)","function getConsolidationRequestFee() view returns(uint256)"]);
async function json<T>(url:string,init:RequestInit={},timeout=20000):Promise<T>{const r=await fetch(url,{...init,signal:AbortSignal.timeout(timeout),cache:"no-store"});if(!r.ok)throw Error(`Data source HTTP ${r.status}`);return r.json() as Promise<T>;}
const providerCooldown=new Map<string,number>();
function providers(network:ConsolidationNetwork){const urls=serverRpcs(network);const available=urls.filter(url=>(providerCooldown.get(url)??0)<Date.now());return available.length?available:urls;}
function coolDown(url:string,error:unknown){if(/HTTP (429|403|502|503)/.test(String(error)))providerCooldown.set(url,Date.now()+60000);}
export async function consolidationRpc<T>(network:ConsolidationNetwork,method:string,params:unknown[]):Promise<T>{
  for(const url of providers(network))try{const b=await json<{result?:T;error?:unknown}>(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});if(!b.error&&b.result!==undefined&&b.result!==null)return b.result;}catch(error){coolDown(url,error);/* Try next provider; never expose runtime URLs. */}
  throw Error(`Consolidation RPC unavailable: ${method}`);
}
async function mapLimit<T,R>(items:T[],limit:number,fn:(v:T)=>Promise<R>):Promise<R[]>{let cursor=0;const out=new Array<R>(items.length);await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{while(cursor<items.length){const i=cursor++;out[i]=await fn(items[i]);}}));return out;}
export async function consolidationBatchRpc<T>(network:ConsolidationNetwork,calls:{method:string;params:unknown[]}[]):Promise<T[]>{
  if(!calls.length)return [];
  for(const url of providers(network))try{
    const body=await json<{id:number;result?:T;error?:unknown}[]>(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(calls.map((call,id)=>({...call,id,jsonrpc:"2.0"})))},30000);
    if(!Array.isArray(body)||body.length!==calls.length)continue;
    const byId=new Map(body.map(v=>[v.id,v]));
    const result=calls.map((_,i)=>byId.get(i));
    if(result.every(v=>v&&!v.error&&v.result!==undefined&&v.result!==null))return result.map(v=>v!.result!);
  }catch(error){coolDown(url,error);/* Some public nodes disable batch requests. */}
  return mapLimit(calls,4,c=>consolidationRpc<T>(network,c.method,c.params));
}
type HistoryCache={version:1;network:ConsolidationNetwork;block:number;blockHash:string;history:ConsolidationHistory};
const cacheFile=(network:ConsolidationNetwork)=>path.join(process.env.CONSOLIDATION_CACHE_DIR??path.join(process.cwd(),".cache","consolidation"),`${rpcCacheKey(network)}-history.json`);
async function persist(cache:HistoryCache){try{const file=cacheFile(cache.network);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file+'.tmp',JSON.stringify(cache),{mode:0o600});await fs.rename(file+'.tmp',file);}catch{/* A read-only filesystem still permits the in-memory monitor. */}}
async function restore(network:ConsolidationNetwork,head:number):Promise<HistoryCache|null>{try{
  const file=cacheFile(network),stat=await fs.stat(file);if(stat.size>100*1024*1024)return null;
  const data=JSON.parse(await fs.readFile(file,"utf8")) as HistoryCache;
  if(data.version!==1||data.network!==network||!Number.isSafeInteger(data.block)||data.block>head)return null;
  const block=await consolidationRpc<{hash:string}>(network,"eth_getBlockByNumber",[hex(data.block),false]);
  return block.hash===data.blockHash?data:null;
}catch{return null;}}
export async function buildConsolidationSnapshot(network:ConsolidationNetwork,progress:(s:string)=>void):Promise<ConsolidationSnapshot>{
  const cfg=CONSOLIDATION_NETWORKS[network],rpc=<T>(method:string,params:unknown[])=>consolidationRpc<T>(network,method,params);
  progress("Reading finalized chain state");
  if(num(await rpc<string>("eth_chainId",[]))!==cfg.chainId)throw Error("Consolidation RPC chain mismatch");
  const head=await rpc<{number:string;hash:string;timestamp:string}>("eth_getBlockByNumber",["finalized",false]),block=num(head.number),timestamp=num(head.timestamp),tag=hex(block);
  async function values(address:string,abi:Interface,method:string,args:unknown[]=[]){return abi.decodeFunctionResult(method,await rpc<string>("eth_call",[{to:address,data:abi.encodeFunctionData(method,args)},tag]));}
  async function value(address:string,abi:Interface,method:string,args:unknown[]=[]){return (await values(address,abi,method,args))[0];}
  const [gateway,sourceModule,targetModule,stakingRouter,busCheck]=await Promise.all([
    value(cfg.bus,BUS,"getConsolidationGateway"),value(cfg.migrator,MIGRATOR,"sourceModuleId"),value(cfg.migrator,MIGRATOR,"targetModuleId"),value(cfg.migrator,MIGRATOR,"getStakingRouter"),value(cfg.migrator,MIGRATOR,"getConsolidationBus"),
  ]);
  if(String(busCheck).toLowerCase()!==cfg.bus.toLowerCase()||Number(sourceModule)!==1)throw Error("Unexpected consolidation deployment or source module");
  const [limitInfo,slot,batchSize,maxGroups,executionDelay,gatewayPaused,dsm,lido,vault]=await Promise.all([
    values(gateway,GATEWAY,"getConsolidationRequestLimitFullInfo"),value(gateway,GATEWAY,"CONSOLIDATION_LIMIT_POSITION"),value(cfg.bus,BUS,"batchSize"),value(cfg.bus,BUS,"maxGroupsInBatch"),value(cfg.bus,BUS,"executionDelay"),value(gateway,GATEWAY,"isPaused"),value(cfg.locator,locator,"depositSecurityModule"),value(cfg.locator,locator,"lido"),value(cfg.locator,locator,"withdrawalVault"),
  ]);
  const [storage,dsmPaused,canDeposit,requestFee]=await Promise.all([rpc<string>("eth_getStorageAt",[gateway,slot,tag]),value(dsm,pauseAbi,"isDepositsPaused"),value(lido,pauseAbi,"canDeposit"),value(vault,pauseAbi,"getConsolidationRequestFee").then(String).catch(()=>null)]);
  const limit=unpackLimit(storage,BigInt(limitInfo.maxLimit)===0n?null:Number(limitInfo.current));
  if(limit.max!==Number(limitInfo.maxLimit)||limit.perFrame!==Number(limitInfo.perFrame)||limit.frameSeconds!==Number(limitInfo.frameSeconds)||limit.previous!==Number(limitInfo.previous)||(!limit.unlimited&&quotaAt(limit,timestamp)!==limit.current))throw Error("Consolidation quota storage does not match contract view");
  const blockers:string[]=[];if(gatewayPaused)blockers.push("Gateway paused");if(dsmPaused)blockers.push("DSM deposits paused");if(!canDeposit)blockers.push("Lido deposits paused / bunker mode");
  let cached=await restore(network,block);
  const history=cached?.history??{batches:[],executions:[]};
  const topics=[...BUS.fragments.filter(f=>f.type==='event').map(f=>BUS.getEvent(f.format())!.topicHash),MIGRATOR.getEvent("ConsolidationSubmitted")!.topicHash];
  const from=cached?cached.block+1:cfg.deployment;
  const ranges=Array.from({length:Math.ceil(Math.max(0,block-from+1)/9000)},(_,i)=>({from:from+i*9000,to:Math.min(block,from+(i+1)*9000-1)}));
  async function logs(start:number,end:number):Promise<ChainLog[]>{try{return await rpc<ChainLog[]>("eth_getLogs",[{address:[cfg.bus,cfg.migrator],topics:[topics],fromBlock:hex(start),toBlock:hex(end)}]);}catch(error){if(end-start<500)throw error;const mid=Math.floor((start+end)/2);return [...await logs(start,mid),...await logs(mid+1,end)];}}
  for(let offset=0;offset<ranges.length;offset+=4){
    progress(`Indexing consolidation history · ${Math.round(offset/ranges.length*100)}%`);
    const chunk=ranges.slice(offset,offset+4),records=(await mapLimit(chunk,4,r=>logs(r.from,r.to))).flat();
    const missing=[...new Set(records.filter(l=>!l.blockTimestamp).map(l=>l.blockNumber))];
    for(let i=0;i<missing.length;i+=50){const numbers=missing.slice(i,i+50),blocks=await consolidationBatchRpc<{timestamp:string}>(network,numbers.map(number=>({method:"eth_getBlockByNumber",params:[number,false]})));const timestamps=new Map(numbers.map((n,j)=>[n,blocks[j].timestamp]));for(const log of records)if(!log.blockTimestamp&&timestamps.has(log.blockNumber))log.blockTimestamp=timestamps.get(log.blockNumber);}
    applyConsolidationLogs(history,records,network);
    const to=chunk.at(-1)!.to,checkpoint=to===block?head:await rpc<{hash:string}>("eth_getBlockByNumber",[hex(to),false]);
    cached={version:1,network,block:to,blockHash:checkpoint.hash,history};await persist(cached);
  }
  progress("Reconciling pending batches and CMv1 operators");
  const pendingBatches=history.batches.filter(b=>b.status==='pending');
  for(let offset=0;offset<pendingBatches.length;offset+=40){
    progress(`Checking pending bus storage · ${Math.min(offset+40,pendingBatches.length)} / ${pendingBatches.length}`);
    const batch=pendingBatches.slice(offset,offset+40);
    const encoded=await consolidationBatchRpc<string>(network,batch.map(b=>({method:'eth_call',params:[{to:cfg.bus,data:BUS.encodeFunctionData('getBatchInfo',[b.hash])},tag]})));
    batch.forEach((b,i)=>{const info=BUS.decodeFunctionResult('getBatchInfo',encoded[i])[0];if(String(info.publisher).toLowerCase()!==b.publisher.toLowerCase()||Number(info.addedAt)!==b.addedAt)throw Error('Pending batch does not match ConsolidationBus storage');});
  }
  const kapi=(network==='mainnet'?process.env.MAINNET_KEYS_API_URL:process.env.HOODI_KEYS_API_URL)??cfg.kapi;
  const names=await Promise.all([Number(sourceModule),Number(targetModule)].map(async id=>{try{const response=await json<{data:{operators:{index:number;name?:string}[]}}>(`${kapi}/v1/modules/${id}/operators`);return response.data.operators.map(o=>({id:o.index,name:o.name||`Operator ${o.index}`}));}catch{return null;}}));
  type Digest={id:bigint;summary:{totalDepositedValidators:bigint;totalExitedValidators:bigint}};
  const digests:Digest[]=[];
  for(let offset=0;offset<10000;offset+=500){const batch=await value(stakingRouter,router,"getNodeOperatorDigests(uint256,uint256,uint256)",[sourceModule,offset,500]) as Digest[];digests.push(...batch);if(batch.length<500)break;if(offset===9500)throw Error("CMv1 operator safety limit exceeded");}
  const nameMap=new Map(names[0]?.map(o=>[o.id,o.name]));
  const operators=operatorCoverage(history.batches,digests.map(d=>({id:Number(d.id),name:nameMap.get(Number(d.id))??`Operator ${d.id}`,deposited:Number(d.summary.totalDepositedValidators),exited:Number(d.summary.totalExitedValidators)})));
  const warnings:string[]=[];
  if(names.some(n=>n===null))warnings.push("Some operator names are unavailable; on-chain IDs and counts are shown.");
  if(history.batches.some(b=>b.sourceOperator===null))warnings.push("Some publications could not be attributed to the CMv1 Migrator; they are included in queue totals but excluded from CMv1 coverage.");
  if(timestamp<Date.now()/1000-1800)warnings.push("Finalized chain state is more than 30 minutes old. Estimates use the displayed snapshot time.");
  let bot:ConsolidationSnapshot['bot']=null;
  if(cfg.bot)try{bot={address:cfg.bot,balanceETH:formatEther(BigInt(await rpc<string>("eth_getBalance",[cfg.bot,tag])))};}catch{warnings.push("Consolidation bot balance is unavailable.");}
  return {network,block,blockHash:head.hash,timestamp,updatedAt:Math.floor(Date.now()/1000),historyFrom:cfg.deployment,bus:cfg.bus,gateway,migrator:cfg.migrator,sourceModule:Number(sourceModule),targetModule:Number(targetModule),batchSize:Number(batchSize),maxGroups:Number(maxGroups),executionDelay:Number(executionDelay),limit,blockers,batches:history.batches,executions:history.executions,operators,targetOperators:names[1]??[],bot,requestFeeWei:requestFee,warnings};
}

export type ExecutionDetail={hash:string;sender:string;to:string|null;success:boolean;gasETH:string;valueETH:string};
const details=new Map<string,ExecutionDetail>();
export async function executionDetails(network:ConsolidationNetwork,hashes:string[]):Promise<ExecutionDetail[]>{
  const needed=hashes.filter(hash=>!details.has(`${rpcCacheKey(network)}:${hash}`));
  if(needed.length){
    const calls=needed.flatMap(hash=>[{method:"eth_getTransactionByHash",params:[hash]},{method:"eth_getTransactionReceipt",params:[hash]}]);
    type Tx={from:string;to:string|null;value:string;status:string;gasUsed:string;effectiveGasPrice:string};
    const rows=await consolidationBatchRpc<Tx>(network,calls);
    needed.forEach((hash,i)=>{const tx=rows[i*2],receipt=rows[i*2+1];details.set(`${rpcCacheKey(network)}:${hash}`,{hash,sender:tx.from,to:tx.to,success:receipt.status==='0x1',gasETH:formatEther(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice)),valueETH:formatEther(BigInt(tx.value))});});
  }
  return hashes.map(hash=>details.get(`${rpcCacheKey(network)}:${hash}`)!);
}

export type BotAttempt={hash:string;timestamp:number;block:number;position:number;sender:string;to:string;success:boolean;gasETH:string;method:string};
export async function recentBotAttempts(network:ConsolidationNetwork,toBlock:number):Promise<{transactions:BotAttempt[];complete:boolean;since:number}>{
  const cfg=CONSOLIDATION_NETWORKS[network],since=Math.floor(Date.now()/1000)-30*86400;
  if(!cfg.bot)return {transactions:[],complete:false,since};
  const transactions:BotAttempt[]=[];let params=new URLSearchParams({filter:'from'}),complete=false;
  // Successful executions are indexed independently from genesis above. This
  // optional indexer feed adds reverted bot attempts in an explicit 30d window.
  for(let page=0;page<80;page++){
    type Item={hash:string;timestamp:string;block_number:number;position:number;from:{hash:string};to:{hash:string}|null;status:string;method:string;fee:{value:string}};
    const body=await json<{items:Item[];next_page_params:Record<string,string|number>|null}>(`${cfg.indexer}/api/v2/addresses/${cfg.bot}/transactions?${params}`);
    if(!Array.isArray(body.items))throw Error("Bot transaction index unavailable");
    for(const t of body.items){const timestamp=Date.parse(t.timestamp)/1000;if(timestamp<since){complete=true;continue;}if(t.block_number>toBlock||t.from.hash.toLowerCase()!==cfg.bot.toLowerCase()||t.to?.hash.toLowerCase()!==cfg.bus.toLowerCase())continue;
      transactions.push({hash:t.hash,timestamp,block:t.block_number,position:t.position,sender:t.from.hash,to:t.to.hash,success:t.status==='ok',gasETH:formatEther(BigInt(t.fee.value)),method:t.method??'Contract call'});
    }
    if(complete||!body.next_page_params){complete=true;break;}
    params=new URLSearchParams(Object.entries(body.next_page_params).map(([k,v])=>[k,String(v)]));params.set('filter','from');
  }
  return {transactions:transactions.sort((a,b)=>a.block-b.block||a.position-b.position),complete,since};
}
