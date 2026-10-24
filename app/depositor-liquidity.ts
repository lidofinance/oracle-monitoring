import { Interface, formatEther, formatUnits } from "ethers";
import { serverRpcs, rpcCacheKey } from "./rpc-server";
import { parseRpcList } from "./rpc-config";
import { beaconUint, EXITING_STATUSES, sumLidoExitBalances, type ExitingValidator } from "./lido-exit-balances-data";
import type { LiquiditySnapshot, LiquidityResponse } from "./depositor-liquidity-data";
type Network=LiquiditySnapshot['network'];
const CONFIG={
  mainnet:{chainId:1,locator:'0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb',root:'0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95',beacon:'https://ethereum-beacon-api.publicnode.com',kapi:'https://keys-api.lido.fi'},
  hoodi:{chainId:560048,locator:'0xe2EF9536DAAAEBFf5b1c130957AB3E80056b06D8',root:'0x212f13fc4df078b6cb7db228f1c8307566dcecf900867401a92023d7ba99cb5f',beacon:'https://ethereum-hoodi-beacon-api.publicnode.com',kapi:'https://keys-api-hoodi.testnet.fi'},
};
const locator=new Interface(['function lido() view returns(address)','function withdrawalQueue() view returns(address)','function accountingOracle() view returns(address)','function withdrawalVault() view returns(address)','function elRewardsVault() view returns(address)']);
const lidoAbi=new Interface(['function getBufferedEther() view returns(uint256)','function getDepositsReserve() view returns(uint256)','function getDepositsReserveTarget() view returns(uint256)']);
const queueAbi=new Interface(['function unfinalizedStETH() view returns(uint256)','function MAX_STETH_WITHDRAWAL_AMOUNT() view returns(uint256)']);
const oracleAbi=new Interface(['function getConsensusContract() view returns(address)']);
const consensusAbi=new Interface(['function getFrameConfig() view returns(uint256 initialEpoch,uint256 epochsPerFrame,uint256 fastLaneLengthSlots)']);
const hex=(n:number)=>`0x${n.toString(16)}`;
const integer=(v:string)=>{const n=Number(beaconUint(v));if(!Number.isSafeInteger(n))throw Error('Unsafe Beacon integer');return n;};
async function json<T>(url:string,init:RequestInit={},timeout=20_000):Promise<T>{const r=await fetch(url,{...init,signal:AbortSignal.timeout(timeout),cache:'no-store'});if(!r.ok)throw Error('Liquidity source unavailable');return r.json() as Promise<T>;}
async function mapLimit<T,R>(items:T[],fn:(v:T)=>Promise<R>){const out=new Array<R>(items.length);let cursor=0;await Promise.all(Array.from({length:Math.min(3,items.length)},async()=>{while(cursor<items.length){const i=cursor++;out[i]=await fn(items[i]);}}));return out;}
export async function collectLiquiditySnapshot(network:Network):Promise<LiquiditySnapshot>{
  const cfg=CONFIG[network],kapi=(network==='mainnet'?process.env.MAINNET_KEYS_API_URL:process.env.HOODI_KEYS_API_URL)??cfg.kapi;
  const status=await json<{chainId:number;elBlockSnapshot:{blockNumber:number;timestamp:number;blockHash:string}}>(`${kapi}/v1/status`);
  if(status.chainId!==cfg.chainId||!Number.isSafeInteger(status.elBlockSnapshot.blockNumber)||Math.abs(Date.now()/1000-status.elBlockSnapshot.timestamp)>300)throw Error('KAPI snapshot is stale or on another chain');
  const block=status.elBlockSnapshot.blockNumber,tag=hex(block);
  const rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{for(const url of serverRpcs(network).slice(0,3))try{const b=await json<{result?:T;error?:unknown}>(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},12000);if(!b.error&&b.result!==undefined&&b.result!==null)return b.result;}catch{/* Retry private configured URLs without exposing them. */}throw Error('Liquidity EL data unavailable');};
  if(Number(BigInt(await rpc<string>('eth_chainId',[])))!==cfg.chainId)throw Error('EL network mismatch');
  const value=async(a:string,abi:Interface,name:string)=>abi.decodeFunctionResult(name,await rpc<string>('eth_call',[{to:a,data:abi.encodeFunctionData(name,[])},tag]));
  const names=['lido','withdrawalQueue','accountingOracle','withdrawalVault','elRewardsVault'];
  const addresses=Object.fromEntries(await Promise.all(names.map(async n=>{const a=String((await value(cfg.locator,locator,n))[0]);if(!/^0x[\da-f]{40}$/i.test(a)||/^0x0{40}$/i.test(a))throw Error('Invalid Lido contract');return[n,a];})));
  const [buffer,lock,target,demand,maxWR,consensusAddress,withdrawalBalance,elBalance]=await Promise.all([
    value(addresses.lido,lidoAbi,'getBufferedEther'),value(addresses.lido,lidoAbi,'getDepositsReserve'),value(addresses.lido,lidoAbi,'getDepositsReserveTarget'),
    value(addresses.withdrawalQueue,queueAbi,'unfinalizedStETH'),value(addresses.withdrawalQueue,queueAbi,'MAX_STETH_WITHDRAWAL_AMOUNT'),
    value(addresses.accountingOracle,oracleAbi,'getConsensusContract'),rpc<string>('eth_getBalance',[addresses.withdrawalVault,tag]),rpc<string>('eth_getBalance',[addresses.elRewardsVault,tag]),
  ]);
  const frame=await value(String(consensusAddress[0]),consensusAbi,'getFrameConfig');
  const providers=[...new Set([cfg.beacon,...parseRpcList(network==='mainnet'?process.env.MAINNET_BEACON_URLS:process.env.HOODI_BEACON_URLS,[])])];
  type ExitRecord=ExitingValidator&{validator:ExitingValidator['validator']&{withdrawal_credentials:string;withdrawable_epoch:string}};
  for(const base of providers.slice(0,3))try{
    const read=async<T>(path:string,verified=true)=>{const b=await json<{data:T;execution_optimistic?:boolean}>(`${base.replace(/\/$/,'')}${path}`);if(b.data===undefined||(verified&&b.execution_optimistic!==false))throw Error('Unverified Beacon state');return b.data;};
    const [genesis,spec]=await Promise.all([read<{genesis_time:string;genesis_validators_root:string}>('/eth/v1/beacon/genesis',false),read<Record<string,string>>('/eth/v1/config/spec',false)]);
    if(genesis.genesis_validators_root!==cfg.root||integer(spec.DEPOSIT_CHAIN_ID)!==cfg.chainId)throw Error('Beacon network mismatch');
    const genesisTime=integer(genesis.genesis_time),secondsPerSlot=spec.SECONDS_PER_SLOT?integer(spec.SECONDS_PER_SLOT):integer(spec.SLOT_DURATION_MS)/1000,slotsPerEpoch=integer(spec.SLOTS_PER_EPOCH);
    if(!Number.isSafeInteger(secondsPerSlot)||secondsPerSlot<1||!slotsPerEpoch)throw Error('Invalid Beacon timing');
    const slot=(status.elBlockSnapshot.timestamp-genesisTime)/secondsPerSlot;
    if(!Number.isSafeInteger(slot)||slot<0)throw Error('Invalid KAPI block time');
    const header=await read<{canonical:boolean;root:string;header:{message:{slot:string;state_root:string}}}>(`/eth/v1/beacon/headers/${slot}`);
    const root=header.header.message.state_root;
    if(!header.canonical||integer(header.header.message.slot)!==slot||!/^0x[\da-f]{64}$/i.test(root)||!/^0x[\da-f]{64}$/i.test(header.root))throw Error('Invalid pinned Beacon header');
    const [records,consolidations,beaconBlock,elBlock]=await Promise.all([
      read<ExitRecord[]>(`/eth/v1/beacon/states/${root}/validators?status=${EXITING_STATUSES.join(',')}`),read<{source_index:string;target_index:string}[]>(`/eth/v1/beacon/states/${root}/pending_consolidations`),
      read<{message:{body:{execution_payload:{block_number:string;block_hash:string;timestamp:string}}}}>(`/eth/v2/beacon/blocks/${header.root}`),
      rpc<{hash:string;timestamp:string}>('eth_getBlockByNumber',[tag,false]),
    ]);
    const payload=beaconBlock.message.body.execution_payload;
    if(integer(payload.block_number)!==block||integer(payload.timestamp)!==status.elBlockSnapshot.timestamp||payload.block_hash.toLowerCase()!==status.elBlockSnapshot.blockHash.toLowerCase()||elBlock.hash.toLowerCase()!==payload.block_hash.toLowerCase())throw Error('EL/CL snapshot mismatch');
    if(!Array.isArray(records)||!Array.isArray(consolidations))throw Error('Incomplete exit registry');
    const sources=new Set(consolidations.map(c=>beaconUint(c.source_index).toString()));
    const candidates=records.filter(v=>beaconUint(v.balance)>0n&&!sources.has(beaconUint(v.index).toString()));
    const keys=new Set<string>(),chunks=Array.from({length:Math.ceil(candidates.length/200)},(_,i)=>candidates.slice(i*200,(i+1)*200).map(v=>v.validator.pubkey.toLowerCase()));
    await mapLimit(chunks,async pubkeys=>{
      if(pubkeys.some(k=>!/^0x[\da-f]{96}$/.test(k)))throw Error('Invalid validator key');
      const found=await json<{data:{key:string;used:boolean}[];meta:{elBlockSnapshot:{blockNumber:number}}}>(`${kapi}/v1/keys/find`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pubkeys})});
      if(!Array.isArray(found.data)||found.meta?.elBlockSnapshot?.blockNumber<block||!Number.isSafeInteger(found.meta?.elBlockSnapshot?.blockNumber))throw Error('Stale KAPI membership');
      const requested=new Set(pubkeys);
      for(const key of found.data){if(typeof key.used!=='boolean'||typeof key.key!=='string'||!requested.has(key.key.toLowerCase()))throw Error('Invalid KAPI membership');if(key.used)keys.add(key.key.toLowerCase());}
    });
    sumLidoExitBalances(records,keys,consolidations,Math.floor(slot/slotsPerEpoch)); // Validate complete status/index lists before calculating a forecast.
    const exits=candidates.filter(v=>keys.has(v.validator.pubkey.toLowerCase())).map(v=>{
      const wc=v.validator.withdrawal_credentials.toLowerCase(),suffix='0'.repeat(22)+addresses.withdrawalVault.slice(2).toLowerCase();
      if(!['0x01'+suffix,'0x02'+suffix].includes(wc))throw Error('Lido withdrawal credentials mismatch');
      const balance=beaconUint(v.balance),cap=(wc.startsWith('0x02')?2048n:32n)*1_000_000_000n,capped=balance<cap?balance:cap;
      const withdrawableEpoch=integer(v.validator.withdrawable_epoch);
      if(withdrawableEpoch<integer(v.validator.exit_epoch))throw Error('Invalid withdrawable epoch');
      return {index:integer(v.index),balanceETH:formatUnits(balance,9),cappedETH:formatUnits(capped,9),excessETH:formatUnits(balance-capped,9),withdrawableAt:genesisTime+withdrawableEpoch*slotsPerEpoch*secondsPerSlot};
    });
    const frameSeconds=Number(frame.epochsPerFrame)*slotsPerEpoch*secondsPerSlot;
    if(!Number.isSafeInteger(frameSeconds)||frameSeconds<1||BigInt(lock[0])>BigInt(buffer[0]))throw Error('Invalid liquidity allocation');
    return {network,timestamp:status.elBlockSnapshot.timestamp,slot,block,bufferETH:formatEther(buffer[0]),demandETH:formatEther(demand[0]),currentDepositLockETH:formatEther(lock[0]),depositTargetETH:formatEther(target[0]),maxWithdrawalETH:formatEther(maxWR[0]),accountingFrameSeconds:frameSeconds,withdrawalVaultETH:formatEther(BigInt(withdrawalBalance)),elVaultETH:formatEther(BigInt(elBalance)),exits};
  }catch{/* Retry a complete pinned Beacon state, never mix roots. */}
  throw Error('Lido liquidity snapshot unavailable');
}
const jobs=new Map<string,{response:LiquidityResponse;finished?:number}>();
export function readLiquiditySnapshot(network:Network):LiquidityResponse{
  let job=jobs.get(rpcCacheKey(network));
  if(!job||(job.finished&&Date.now()-job.finished>(job.response.status==='unavailable'?15_000:300_000))){
    job={response:{network,status:'loading',snapshot:null}};jobs.set(rpcCacheKey(network),job);const current=job;
    void collectLiquiditySnapshot(network).then(snapshot=>{current.response={network,status:'ready',snapshot};},()=>{current.response={network,status:'unavailable',snapshot:null};}).finally(()=>{current.finished=Date.now();});
  }
  return job.response;
}
