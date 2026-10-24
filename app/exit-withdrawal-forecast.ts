import { Interface, formatEther } from "ethers";
import { serverRpcs, rpcCacheKey } from "./rpc-server";
import { parseRpcList } from "./rpc-config";
import { blockAtOrBefore } from "./depositor-history";
import { REWARD_REPORT_ABI, clRewardRate } from "./depositor-liquidity-data";
import { beaconStateLayout, parseBeaconStatePrefix, newExitEpoch, scanActiveValidatorRegistry, activeValidatorSweepSeconds, vaultInflow, type ExitWithdrawalForecast, type WithdrawalTiming, type LidoInflow } from "./exit-withdrawal-forecast-data";

type Network=ExitWithdrawalForecast["network"];
const CONFIG={
  mainnet:{chainId:1,locator:"0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb",root:"0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95",archive:"http://hr6vb81d1ndsx-cl-3-mainnet-lighthouse.tooling-nodes.testnet.fi",explorer:"https://etherscan.io"},
  hoodi:{chainId:560048,locator:"0xe2EF9536DAAAEBFf5b1c130957AB3E80056b06D8",root:"0x212f13fc4df078b6cb7db228f1c8307566dcecf900867401a92023d7ba99cb5f",archive:"http://hr6vb81d1ndsx-cl-5-hoodi-lighthouse.tooling-nodes.testnet.fi",explorer:"https://hoodi.etherscan.io"},
};
const num=(v:string)=>{if(!/^(?:0x[\da-f]+|\d+)$/i.test(v))throw Error("Invalid chain integer");const n=Number(BigInt(v));if(!Number.isSafeInteger(n)||n<0)throw Error("Unsafe chain integer");return n;};
const hex=(v:number)=>`0x${v.toString(16)}`;
const address=(v:string)=>{if(!/^0x[\da-f]{40}$/i.test(v)||/^0x0{40}$/i.test(v))throw Error("Invalid vault address");return v;};
async function mapLimit<T,R>(items:T[],limit:number,fn:(v:T)=>Promise<R>){let cursor=0;const result=new Array<R>(items.length);await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const i=cursor++;result[i]=await fn(items[i]);}}));return result;}

export async function collectWithdrawalTiming(network:Network):Promise<WithdrawalTiming>{
  const cfg=CONFIG[network];
  const endpoints=parseRpcList(network==='mainnet'?process.env.MAINNET_BEACON_URLS:process.env.HOODI_BEACON_URLS,[cfg.archive]);
  for(const base of endpoints.slice(0,3))try{
    const signal=AbortSignal.timeout(90_000);
    const read=async<T>(path:string,verified=false):Promise<T>=>{const r=await fetch(base.replace(/\/$/,'')+path,{signal,cache:'no-store'});if(!r.ok)throw Error(`Beacon ${r.status}`);const b=await r.json() as {data:T;execution_optimistic?:boolean};if(b.data===undefined||(verified&&b.execution_optimistic!==false))throw Error('Unverified Beacon state');return b.data;};
    type Header={canonical:boolean;header:{message:{slot:string;state_root:string}}};
    const [genesis,spec,head]=await Promise.all([
      read<{genesis_time:string;genesis_validators_root:string}>('/eth/v1/beacon/genesis'),read<Record<string,string>>('/eth/v1/config/spec'),read<Header>('/eth/v1/beacon/headers/head',true),
    ]);
    if(genesis.genesis_validators_root!==cfg.root||num(spec.DEPOSIT_CHAIN_ID)!==cfg.chainId)throw Error('Wrong Beacon network');
    const genesisTime=num(genesis.genesis_time),secondsPerSlot=spec.SECONDS_PER_SLOT?num(spec.SECONDS_PER_SLOT):num(spec.SLOT_DURATION_MS)/1000;
    const slotsPerEpoch=num(spec.SLOTS_PER_EPOCH),epochSeconds=secondsPerSlot*slotsPerEpoch;
    const slot=num(head.header.message.slot),observedAt=genesisTime+slot*secondsPerSlot;
    if(!Number.isSafeInteger(secondsPerSlot)||secondsPerSlot<1||!slotsPerEpoch||Math.abs(Date.now()/1000-observedAt)>180||num(spec.MIN_PER_EPOCH_CHURN_LIMIT_ELECTRA)<32_000_000_000)throw Error('Invalid Beacon timing or churn');
    const stateSnapshot=async(h:Header)=>{
      const root=h.header.message.state_root,at=num(h.header.message.slot);
      if(!h.canonical||!/^0x[\da-f]{64}$/i.test(root))throw Error('Invalid Beacon header');
      const response=await fetch(`${base.replace(/\/$/,'')}/eth/v2/debug/beacon/states/${root}`,{signal,cache:'no-store',headers:{accept:'application/octet-stream'}});
      if(!response.ok||!response.headers.get('content-type')?.includes('application/octet-stream')||!response.body)throw Error('State prefix unavailable');
      const version=response.headers.get('eth-consensus-version')??'';
      const {size,offsets}=beaconStateLayout(spec,version),bytes=new Uint8Array(size);let offset=0;
      const reader=response.body.getReader();
      try{
        let remainder:Uint8Array|undefined;
        while(offset<size){
          const chunk=await reader.read();if(chunk.done)throw Error('Truncated state');
          const length=Math.min(chunk.value.length,size-offset);bytes.set(chunk.value.subarray(0,length),offset);offset+=length;
          if(length<chunk.value.length)remainder=chunk.value.subarray(length);
        }
        const state=parseBeaconStatePrefix(bytes,spec,version,{slot:at,genesisRoot:cfg.root,genesisTime});
        const registryStart=new DataView(bytes.buffer).getUint32(offsets.validators,true);
        async function* chunks(){
          yield bytes;if(remainder)yield remainder;
          while(true){const part=await reader.read();if(part.done)return;yield part.value;}
        }
        const activeValidators=await scanActiveValidatorRegistry(chunks(),{from:registryStart,validators:state.validators,epoch:Math.floor(at/slotsPerEpoch)});
        return {...state,activeValidators};
      }finally{await reader.cancel().catch(()=>{});}
    };
    const current=await stateSnapshot(head),withdrawalsPerPayload=num(spec.MAX_WITHDRAWALS_PER_PAYLOAD);
    const cycle=activeValidatorSweepSeconds({activeValidators:current.activeValidators,withdrawalsPerPayload,secondsPerSlot});
    const epoch=newExitEpoch(Math.floor(slot/slotsPerEpoch),current.earliestExitEpoch,current.exitBalanceToConsume,num(spec.MAX_SEED_LOOKAHEAD));
    const exitAt=genesisTime+epoch*epochSeconds,withdrawalDelaySeconds=num(spec.MIN_VALIDATOR_WITHDRAWABILITY_DELAY)*epochSeconds;
    const eligibleAt=exitAt+withdrawalDelaySeconds;
    return {observedAt,slot,exitAt,eligibleAt,averageWithdrawalAt:eligibleAt+Math.round(cycle/2),lateWithdrawalAt:eligibleAt+cycle,withdrawalDelaySeconds,sweepCycleSeconds:cycle,sweepMethod:"active-validators",activeValidators:current.activeValidators,withdrawalsPerPayload,secondsPerSlot};
  }catch{/* Each attempt uses one network-checked provider and pinned states. */}
  throw Error('Withdrawal timing unavailable');
}
const locator=new Interface(['function lido() view returns(address)','function withdrawalVault() view returns(address)','function elRewardsVault() view returns(address)']);
const events=new Interface(['event WithdrawalsReceived(uint256 amount)','event ELRewardsReceived(uint256 amount)']);
type Block={number:string;timestamp:string;hash:string};
export async function collectLidoInflow(network:Network):Promise<LidoInflow>{
  const cfg=CONFIG[network];
  const rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{
    for(const url of serverRpcs(network).slice(0,3))try{
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(12_000),cache:'no-store'});
      if(!r.ok)continue;const b=await r.json() as {result?:T;error?:unknown};if(!b.error&&b.result!==undefined&&b.result!==null)return b.result;
    }catch{/* Retry without exposing node URLs. */}throw Error(`Inflow ${method} unavailable`);
  };
  if(num(await rpc<string>('eth_chainId',[]))!==cfg.chainId)throw Error('Wrong EL network');
  const block=async(n:number|'latest')=>rpc<Block>('eth_getBlockByNumber',[n==='latest'?n:hex(n),false]);
  const head=await block('latest'),end=await block(num(head.number)-2),endNumber=num(end.number),to=num(end.timestamp);
  if(Math.abs(Date.now()/1000-to)>300)throw Error('Old EL head');
  const timed=(b:Block)=>({number:num(b.number),timestamp:num(b.timestamp)});
  const lower=await block(Math.max(0,endNumber-14*7200));
  const startNumber=await blockAtOrBefore(to-7*86400,timed(lower),timed(end),async n=>timed(await block(n)));
  const start=await block(startNumber),from=num(start.timestamp);
  const call=async(name:string,at:number)=>address(String(locator.decodeFunctionResult(name,await rpc<string>('eth_call',[{to:cfg.locator,data:locator.encodeFunctionData(name,[])},hex(at)]))[0]));
  const [lido,withdrawalVault,elRewardsVault]=await Promise.all(['lido','withdrawalVault','elRewardsVault'].map(n=>call(n,endNumber)));
  // A changed locator over the sample must not produce misleading balance deltas.
  const old=await Promise.all(['lido','withdrawalVault','elRewardsVault'].map(n=>call(n,startNumber)));
  if(old.some((v,i)=>v.toLowerCase()!==[lido,withdrawalVault,elRewardsVault][i].toLowerCase()))throw Error('Vault rotation in inflow window');
  const balances=await Promise.all([withdrawalVault,elRewardsVault].flatMap(a=>[startNumber,endNumber].map(at=>rpc<string>('eth_getBalance',[a,hex(at)]).then(BigInt))));
  const ranges=Array.from({length:Math.ceil((endNumber-startNumber)/9000)},(_,i)=>({from:startNumber+1+i*9000,to:Math.min(endNumber,startNumber+(i+1)*9000)}));
  type Log={address:string;topics:string[];data:string;blockNumber:string;removed?:boolean;transactionHash:string;logIndex:string};
  const rewardTopics=['ETHDistributed','TokenRebased'].map(n=>REWARD_REPORT_ABI.getEvent(n)!.topicHash);
  const topics=[...['WithdrawalsReceived','ELRewardsReceived'].map(n=>events.getEvent(n)!.topicHash),...rewardTopics];
  const logs=(await mapLimit(ranges,3,r=>rpc<Log[]>('eth_getLogs',[{address:lido,topics:[topics],fromBlock:hex(r.from),toBlock:hex(r.to)}]))).flat();
  let sweeps=0n,rewards=0n;const seen=new Set<string>();
  const reportLogs:Log[]=[];
  for(const log of logs){
    if(log.removed||log.address.toLowerCase()!==lido.toLowerCase()||num(log.blockNumber)<=startNumber||num(log.blockNumber)>endNumber)throw Error('Invalid inflow logs');
    const key=`${log.transactionHash}:${log.logIndex}`;if(seen.has(key))throw Error('Duplicate inflow log');seen.add(key);
    if(rewardTopics.includes(log.topics[0])){reportLogs.push(log);continue;}
    const event=events.parseLog(log);if(!event)throw Error('Unknown inflow event');
    if(event.name==='WithdrawalsReceived')sweeps+=BigInt(event.args[0]);else if(event.name==='ELRewardsReceived')rewards+=BigInt(event.args[0]);else throw Error('Unexpected inflow event');
  }
  const [startCheck,endCheck]=await Promise.all([block(startNumber),block(endNumber)]);
  if(startCheck.hash!==start.hash||endCheck.hash!==end.hash)throw Error('EL reorg during inflow sampling');
  const sweepETH=formatEther(vaultInflow(balances[0],balances[1],sweeps)),elRewardsETH=formatEther(vaultInflow(balances[2],balances[3],rewards));
  const days=(to-from)/86400;if(days<7||days>7.01)throw Error('Invalid inflow sample window');
  let dailyCLETH:number|null=null,clReports=0;
  try{const rate=clRewardRate(reportLogs);dailyCLETH=rate.dailyCLETH;clReports=rate.reports;}catch{/* Preserve verified vault arrivals when report pairing is unavailable. */}
  return {from,to,sweepETH,elRewardsETH,dailyCLETH,clReports,dailySweepETH:Number(sweepETH)/days,dailyELRewardsETH:Number(elRewardsETH)/days,withdrawalVault,elRewardsVault,explorer:cfg.explorer};
}
const jobs=new Map<string,{result:ExitWithdrawalForecast;finished?:number}>();
export function readExitWithdrawalForecast(network:Network):ExitWithdrawalForecast{
  let job=jobs.get(rpcCacheKey(network));
  const unavailable=job?.result.timingStatus==='unavailable'||job?.result.inflowStatus==='unavailable';
  if(!job||(job.finished&&Date.now()-job.finished>(unavailable?15_000:300_000))){
    const previous=job?.result,now=Math.floor(Date.now()/1000);
    const timingData=previous?.timingStatus==='ready'&&previous.timing&&now-previous.timing.observedAt<300?previous.timing:null;
    const inflowData=previous?.inflowStatus==='ready'&&previous.inflow&&now-previous.inflow.to<300?previous.inflow:null;
    job={result:{network,status:'loading',updatedAt:now,timing:timingData,inflow:inflowData,timingStatus:timingData?'ready':'loading',inflowStatus:inflowData?'ready':'loading'}};
    jobs.set(rpcCacheKey(network),job);const current=job;
    const timing=timingData?Promise.resolve():collectWithdrawalTiming(network).then(v=>{current.result.timing=v;current.result.timingStatus='ready';},()=>{current.result.timingStatus='unavailable';});
    const inflow=inflowData?Promise.resolve():collectLidoInflow(network).then(v=>{current.result.inflow=v;current.result.inflowStatus='ready';},()=>{current.result.inflowStatus='unavailable';});
    void Promise.all([timing,inflow]).then(()=>{current.result.status='ready';current.result.updatedAt=Math.floor(Date.now()/1000);current.finished=Date.now();});
  }
  return job.result;
}
