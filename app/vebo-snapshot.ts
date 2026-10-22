import { Interface, formatEther } from "ethers";
import { serverRpcs, parseRpcList } from "./rpc-config";
import routerAbi from "./vebo-stakingrouter-abi";
import sanityAbi from "./vebo-oraclereportsanitychecker-abi";
import metaAbi from "./vebo-metaregistry-abi";
import { exampleScenario, type ExitScenario, type SimGroup, type SimOperator } from "./vebo-simulation";
import { validPendingDeposit } from "./vebo-deposit-signature";
export type SnapshotMeta = { network: "mainnet"|"hoodi"; block: number; blockHash: string; refSlot: number; stateRoot: string; timestamp: number; keysApi: string; validators: number; excluded: number; pending: number; groups: number; warnings: string[]; source: "live"; reference: "frame"|"finalized" };
export type VeboSnapshot = { scenario: ExitScenario; meta: SnapshotMeta };
type Network = ExitScenario["network"];
type BeaconValidator = { index: string; balance: string; validator: { pubkey: string; withdrawal_credentials: string; effective_balance: string; slashed: boolean; exit_epoch: string; withdrawable_epoch: string } };
type Pending = { pubkey: string; amount: string; withdrawal_credentials: string; signature: string };
type Key = { key: string; operatorIndex: number; index: number; moduleAddress: string; used: boolean };
type Digest = { id: bigint; summary: { totalDepositedValidators: bigint; totalExitedValidators: bigint; targetLimitMode: bigint; targetValidatorsCount: bigint } };
type Module = { id: bigint; stakingModuleAddress: string; name: string; priorityExitShareThreshold: bigint; withdrawalCredentialsType: bigint };
const config = {
  mainnet: { chainId:1, locator:"0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb", kapi:"https://keys-api.lido.fi", beacon:["https://ethereum-beacon-api.publicnode.com"] },
  hoodi: { chainId:560048, locator:"0xe2EF9536DAAAEBFf5b1c130957AB3E80056b06D8", kapi:"https://keys-api-hoodi.testnet.fi", beacon:["https://ethereum-hoodi-beacon-api.publicnode.com","https://lodestar-hoodi.chainsafe.io"] },
};
const locatorAbi=new Interface(["function stakingRouter() view returns(address)","function validatorsExitBusOracle() view returns(address)","function oracleReportSanityChecker() view returns(address)","function withdrawalQueue() view returns(address)","function lido() view returns(address)","function withdrawalVault() view returns(address)","function elRewardsVault() view returns(address)","function oracleDaemonConfig() view returns(address)"]);
const oracleAbi=new Interface(["function getConsensusContract() view returns(address)","function isPaused() view returns(bool)"]);
const consensusAbi=new Interface(["function getCurrentFrame() view returns(uint256 refSlot,uint256 reportProcessingDeadlineSlot)","function getFrameConfig() view returns(uint256 initialEpoch,uint256 epochsPerFrame,uint256 fastLaneLengthSlots)","function getChainConfig() view returns(uint256 slotsPerEpoch,uint256 secondsPerSlot,uint256 genesisTime)"]);
const curatedAbi=new Interface(["function getOperatorWeights(uint256[]) view returns(uint256[])","function META_REGISTRY() view returns(address)","function getNodeOperatorDepositInfoToUpdateCount() view returns(uint256)"]);
const queueAbi=new Interface(["function unfinalizedStETH() view returns(uint256)"]);
const lidoAbi=new Interface(["function getWithdrawalsReserve() view returns(uint256)"]);
const daemonAbi=new Interface(["function get(string) view returns(bytes)"]);
const exitAbi=new Interface(["event ValidatorExitRequest(uint256 indexed stakingModuleId,uint256 indexed nodeOperatorId,uint256 indexed validatorIndex,bytes validatorPubkey,uint256 timestamp)"]);
const router=new Interface(routerAbi), sanity=new Interface(sanityAbi), registry=new Interface(metaAbi);
async function mapLimit<T,R>(items: T[], limit: number, fn:(item:T,index:number)=>Promise<R>) {let cursor=0;const out=new Array<R>(items.length);await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const i=cursor++;out[i]=await fn(items[i],i);}}));return out;}
async function json<T>(url:string, init:RequestInit={}, timeout=30000):Promise<T> {const r=await fetch(url,{...init,signal:AbortSignal.timeout(timeout),cache:"no-store"});if(!r.ok)throw new Error(`Public data source returned HTTP ${r.status}`);return r.json() as Promise<T>;}
export async function buildVeboSnapshot(network:Network, progress:(message:string)=>void, reference:"frame"|"finalized"="frame"):Promise<VeboSnapshot> {
  const cfg=config[network], warnings:string[]=[];
  const kapi=network==="mainnet" ? process.env.MAINNET_KEYS_API_URL ?? cfg.kapi : process.env.HOODI_KEYS_API_URL ?? cfg.kapi;
  const beacons=parseRpcList(network==="mainnet" ? process.env.MAINNET_BEACON_URLS : process.env.HOODI_BEACON_URLS,cfg.beacon);
  async function rpc<T>(method:string,params:unknown[]):Promise<T> {
    for(const url of serverRpcs(network).slice(0,3))try{const b=await json<{result?:T;error?:unknown}>(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})},15000);if(b.result!==undefined && b.result!==null && !b.error)return b.result;}catch{/* fallback */}
    throw new Error(`Execution RPC unavailable: ${method}`);
  }
  async function beacon<T>(path:string,body?:unknown):Promise<T> {
    // Public nodes serve historical blocks quickly; the configured archive
    // nodes reconstruct historical state and may need several minutes.
    const providers=[...new Set(path.includes("/beacon/states/")&&reference==="frame"?[...beacons,...cfg.beacon]:[...cfg.beacon,...beacons])];
    for(const url of providers)try{const b=await json<{data:T;execution_optimistic?:boolean}>(`${url}${path}`,body ? {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)} : {},beacons.includes(url)&&!cfg.beacon.includes(url)?180000:45000);if(b.execution_optimistic)throw Error("Optimistic beacon state");return b.data;}catch{/* fallback */}
    throw new Error(`Beacon data unavailable: ${path.split('/').at(-1)}. A public archive Beacon endpoint may be required.`);
  }
  progress("Keys API и reporting frame");
  const status=await json<{chainId:number;elBlockSnapshot:{blockNumber:number};clBlockSnapshot:{slot:number;blockHash:string}}>(`${kapi}/v1/status`);
  if(status.chainId!==cfg.chainId || Number(BigInt(await rpc<string>("eth_chainId",[])))!==cfg.chainId)throw Error("Network mismatch in Keys API or execution RPC");
  let blockTag='0x'+status.elBlockSnapshot.blockNumber.toString(16);
  async function values(address:string,abi:Interface,method:string,args:unknown[]=[]) {return abi.decodeFunctionResult(method,await rpc<string>("eth_call",[{to:address,data:abi.encodeFunctionData(method,args)},blockTag]));}
  async function value(address:string,abi:Interface,method:string,args:unknown[]=[]) {return (await values(address,abi,method,args))[0];}
  const vebo=String(await value(cfg.locator,locatorAbi,"validatorsExitBusOracle")), consensus=String(await value(vebo,oracleAbi,"getConsensusContract"));
  const [frame,frameConfig,chainConfig]=await Promise.all([values(consensus,consensusAbi,"getCurrentFrame"),values(consensus,consensusAbi,"getFrameConfig"),values(consensus,consensusAbi,"getChainConfig")]);
  let refSlot=Number(frame.refSlot); const secondsPerSlot=Number(chainConfig.secondsPerSlot);
  if(refSlot>status.clBlockSnapshot.slot)throw Error("Keys API consensus snapshot has not reached the current reporting frame yet. Try later.");
  let header:{header:{message:{slot:string;state_root:string}}}|null=null;
  if(reference==="finalized") {header=await beacon("/eth/v1/beacon/headers/finalized");refSlot=Number(header!.header.message.slot);}
  else for(let slot=refSlot;slot>=refSlot-32;slot--)try{header=await beacon(`/eth/v1/beacon/headers/${slot}`);break;}catch{/* refSlot may be skipped */}
  if(!header)throw Error("Could not resolve the VEBO reference slot");
  const actualSlot=Number(header.header.message.slot), stateRoot=header.header.message.state_root;
  progress(`${reference==="frame"?"VEBO reference":"Finalized"} slot ${actualSlot.toLocaleString("en-US")} · reading state`);
  const block=await beacon<{message:{body:{execution_payload:{block_number:string;block_hash:string;timestamp:string}}}}>(`/eth/v2/beacon/blocks/${actualSlot}`);
  const payload=block.message.body.execution_payload, blockNumber=Number(payload.block_number), timestamp=Number(payload.timestamp);
  if(status.elBlockSnapshot.blockNumber<blockNumber)throw Error("Keys API execution snapshot is behind the VEBO reference block");
  blockTag='0x'+blockNumber.toString(16);
  const elBlock=await rpc<{hash:string}>("eth_getBlockByNumber",[blockTag,false]);if(elBlock.hash.toLowerCase()!==payload.block_hash.toLowerCase())throw Error("EL and Beacon block hashes disagree");
  const addresses=Object.fromEntries(await Promise.all(["stakingRouter","oracleReportSanityChecker","withdrawalQueue","lido","withdrawalVault","elRewardsVault","oracleDaemonConfig"].map(async name=>[name,String(await value(cfg.locator,locatorAbi,name))])));
  const [modules,limits,pending,consolidations,genesis,lookbackRaw,demand,reserve,paused]=await Promise.all([
    value(addresses.stakingRouter,router,"getStakingModules") as Promise<Module[]>,
    value(addresses.oracleReportSanityChecker,sanity,"getOracleReportLimits"),
    beacon<Pending[]>(`/eth/v1/beacon/states/${stateRoot}/pending_deposits`),
    beacon<{source_index:string;target_index:string}[]>(`/eth/v1/beacon/states/${stateRoot}/pending_consolidations`),
    beacon<{genesis_fork_version:string}>("/eth/v1/beacon/genesis"),
    value(addresses.oracleDaemonConfig,daemonAbi,"get",["EXIT_EVENTS_LOOKBACK_WINDOW_IN_SLOTS"]),
    value(addresses.withdrawalQueue,queueAbi,"unfinalizedStETH"), value(addresses.lido,lidoAbi,"getWithdrawalsReserve"),value(vebo,oracleAbi,"isPaused"),
  ]);
  if(paused)warnings.push("VEBO contract is paused at the reference block. Queue simulation does not imply a report can be submitted.");
  const lookback=Number(BigInt(lookbackRaw)), from=Math.max(0,blockNumber-Math.ceil(lookback*secondsPerSlot/12)-1000), recent=new Set<number>();
  const ranges=Array.from({length:Math.ceil((blockNumber-from+1)/9000)},(_,i)=>({start:from+i*9000,end:Math.min(blockNumber,from+(i+1)*9000-1)}));
  const cutoff=Number(chainConfig.genesisTime)+refSlot*secondsPerSlot-lookback*secondsPerSlot;
  await mapLimit(ranges,3,async({start,end})=>{const logs=await rpc<{topics:string[];data:string}[]>("eth_getLogs",[{address:vebo,topics:[exitAbi.getEvent("ValidatorExitRequest")!.topicHash],fromBlock:'0x'+start.toString(16),toBlock:'0x'+end.toString(16)}]);for(const log of logs){const e=exitAbi.parseLog(log)!;if(Number(e.args.timestamp)>=cutoff)recent.add(Number(e.args.validatorIndex));}});
  const operators:SimOperator[]=[],keyMap=new Map<string,{operator:SimOperator;keyIndex:number}>(),depositedById=new Map<string,number>();
  const groups:SimGroup[]=[];
  progress("Операторы, ключи и MetaRegistry");
  for(const m of modules) {
    const mid=Number(m.id);progress(`Keys API · ${m.name}`);
    const digests:Digest[]=[];
    for(let offset=0;offset<10000;offset+=500){const batch=await value(addresses.stakingRouter,router,"getNodeOperatorDigests(uint256,uint256,uint256)",[m.id,offset,500]) as Digest[];digests.push(...batch);if(batch.length<500)break;if(offset===9500)throw Error("Operator count exceeds snapshot safety limit");}
    const names=await json<{data:{operators:{index:number;name?:string}[]};meta?:{elBlockSnapshot?:{blockNumber:number}}}>(`${kapi}/v1/modules/${mid}/operators`);
    const nameMap=new Map(names.data.operators.map(o=>[o.index,o.name]));
    let weights:bigint[]|null=null;
    if(m.name==="curated-onchain-v2") {
      if(Number(await value(m.stakingModuleAddress,curatedAbi,"getNodeOperatorDepositInfoToUpdateCount"))!==0)throw Error("Curated v2 operator weights require an update; Oracle would not build a report.");
      weights=[];for(let i=0;i<digests.length;i+=300)weights.push(...await value(m.stakingModuleAddress,curatedAbi,"getOperatorWeights",[digests.slice(i,i+300).map(d=>d.id)]) as bigint[]);
      const metaAddress=String(await value(m.stakingModuleAddress,curatedAbi,"META_REGISTRY")), count=Number(await value(metaAddress,registry,"getOperatorGroupsCount"));
      if(count>1000)throw Error("Too many MetaRegistry groups");
      const all=await mapLimit(Array.from({length:count},(_,i)=>i+1),4,i=>value(metaAddress,registry,"getOperatorGroup",[i]));
      for(const g of all)groups.push({name:g.name,internal:Array.from(g.subNodeOperators,(o:{nodeOperatorId:bigint;share:bigint})=>({operatorId:`${mid}:${o.nodeOperatorId}`,shareBps:Number(o.share)})),external:Array.from(g.externalOperators,(o:{data:string})=>{const hex=o.data.slice(2);if(hex.length!==20)throw Error("Invalid MetaRegistry identity");return `${parseInt(hex.slice(2,4),16)}:${BigInt('0x'+hex.slice(4))}`;})});
    }
    for(let i=0;i<digests.length;i++) {
      const d=digests[i],id=`${mid}:${d.id}`;depositedById.set(id,Number(d.summary.totalDepositedValidators));
      operators.push({id,moduleId:mid,name:nameMap.get(Number(d.id)) || `Module ${mid} · operator ${d.id}`,validators:0,excluded:0,pending:0,pendingBalanceETH:0,balanceETH:32,credential:Number(m.withdrawalCredentialsType)===2 ? "0x02" : "0x01",weight:weights ? Number(weights[i]) : 100000,mode:Number(d.summary.targetLimitMode)>=2 ? "force" : Number(d.summary.targetLimitMode)===1 ? "soft" : "none",target:Number(d.summary.targetValidatorsCount),indexStart:0,validatorData:[]});
    }
    const opMap=new Map(operators.filter(o=>o.moduleId===mid).map(o=>[Number(o.id.split(':')[1]),o]));
    const keys=await json<{data:{keys:Key[]};meta?:{elBlockSnapshot?:{blockNumber:number}}}>(`${kapi}/v1/modules/${mid}/keys?used=true`,{},90000);
    if(!keys.meta?.elBlockSnapshot || keys.meta.elBlockSnapshot.blockNumber<blockNumber)throw Error("Keys API keys are stale for the requested reference block");
    const received=new Map<string,Set<number>>();
    for(const key of keys.data.keys) {
      const op=opMap.get(key.operatorIndex);if(!key.used || !op || key.index>=depositedById.get(op.id)!)continue;
      if(key.moduleAddress.toLowerCase()!==m.stakingModuleAddress.toLowerCase() || keyMap.has(key.key.toLowerCase()))throw Error("Duplicate or mismatched key identity");
      keyMap.set(key.key.toLowerCase(),{operator:op,keyIndex:key.index});let set=received.get(op.id);if(!set){set=new Set();received.set(op.id,set);}set.add(key.index);
    }
    for(const op of opMap.values())if((received.get(op.id)?.size ?? 0)!==depositedById.get(op.id))throw Error(`Keys API is missing deposited keys for ${op.id}`);
  }
  const allKeys=[...keyMap.keys()], byIndex=new Map<number,BeaconValidator>(), byKey=new Map<string,BeaconValidator>();
  const chunks=Array.from({length:Math.ceil(allKeys.length/1000)},(_,i)=>allKeys.slice(i*1000,(i+1)*1000));let done=0;
  progress(`Beacon: 0 / ${allKeys.length} ключей`);
  await mapLimit(chunks,4,async ids=>{const records=await beacon<BeaconValidator[]>(`/eth/v1/beacon/states/${stateRoot}/validators`,{ids});for(const v of records){byIndex.set(Number(v.index),v);byKey.set(v.validator.pubkey.toLowerCase(),v);}done+=ids.length;progress(`Beacon: ${done.toLocaleString('ru-RU')} / ${allKeys.length.toLocaleString('ru-RU')} ключей`);});
  const missingSources=consolidations.map(c=>c.source_index).filter(id=>!byIndex.has(Number(id)));
  await mapLimit(Array.from({length:Math.ceil(missingSources.length/1000)},(_,i)=>missingSources.slice(i*1000,(i+1)*1000)),4,async ids=>{for(const v of await beacon<BeaconValidator[]>(`/eth/v1/beacon/states/${stateRoot}/validators`,{ids}))byIndex.set(Number(v.index),v);});
  const inbound=new Map<number,number>(), sources=new Set<number>(), topups=new Map<string,number>();
  for(const c of consolidations){const v=byIndex.get(Number(c.source_index));if(!v)throw Error("Missing consolidation source");if(v.validator.slashed)continue;sources.add(Number(c.source_index));const cap=v.validator.withdrawal_credentials.startsWith('0x02') ? 2048 : 32;inbound.set(Number(c.target_index),(inbound.get(Number(c.target_index)) ?? 0)+Math.min(Number(v.balance)/1e9,cap));}
  const wcSuffix='0'.repeat(22)+addresses.withdrawalVault.slice(2).toLowerCase(), acceptedPending=new Set<string>();
  progress("Проверка pending deposits и согласованности снимка");
  let checkedPending=0;
  for(const d of pending) {
    if(++checkedPending%10===0) await new Promise(resolve=>setTimeout(resolve,0));
    const key=d.pubkey.toLowerCase(), link=keyMap.get(key);if(!link)continue;
    if(byKey.has(key)){topups.set(key,(topups.get(key) ?? 0)+Number(d.amount)/1e9);continue;}
    if(!acceptedPending.has(key)) {
      if(!validPendingDeposit(d,genesis.genesis_fork_version))continue;
      if(!['0x01'+wcSuffix,'0x02'+wcSuffix].includes(d.withdrawal_credentials.toLowerCase()))throw Error("Pending Lido key has non-Lido withdrawal credentials");acceptedPending.add(key);link.operator.pending++;
    }
    const cap=d.withdrawal_credentials.startsWith('0x02') ? 2048 : 32;
    const prior=topups.get(key) ?? 0, next=Math.min(prior+Number(d.amount)/1e9,cap);topups.set(key,next);link.operator.pendingBalanceETH!+=next-prior;
  }
  let incomingETH=0, excluded=0;
  let reconciled=0;
  for(const [key,link] of keyMap) {
    if(++reconciled%10000===0) await new Promise(resolve=>setTimeout(resolve,0));
    const v=byKey.get(key);if(!v){if(!acceptedPending.has(key))throw Error(`Deposited key is missing from Beacon and valid pending deposits (${link.operator.id}); exact snapshot blocked.`);continue;}
    const cap:32|2048=v.validator.withdrawal_credentials.startsWith('0x02') ? 2048 : 32;
    if(!['0x01'+wcSuffix,'0x02'+wcSuffix].includes(v.validator.withdrawal_credentials.toLowerCase()))throw Error("Registered Lido key has non-Lido withdrawal credentials");
    const predictable=Math.min(Number(v.balance)/1e9+(topups.get(key) ?? 0)+(inbound.get(Number(v.index)) ?? 0),cap);
    const isOnExit=v.validator.exit_epoch!=="18446744073709551615", requested=recent.has(Number(v.index));link.operator.validators++;
    if(isOnExit || requested || sources.has(Number(v.index))) {
      link.operator.excluded++;excluded++;
      // Count principal once: pending requests and scheduled exits, never exited
      // zero-balance validators or consolidation sources.
      if(!sources.has(Number(v.index)) && (requested || isOnExit) && Number(v.balance)>0)incomingETH+=predictable;
    } else link.operator.validatorData!.push({index:Number(v.index),balanceETH:predictable,maxEffectiveETH:cap});
  }
  // Every used/deposited key must reconcile, including registered and pending.
  for(const op of operators)if(op.validators+op.pending!==depositedById.get(op.id))throw Error(`Validator reconciliation failed for ${op.id}`);
  const balances=await Promise.all([addresses.withdrawalVault,addresses.elRewardsVault].map(a=>rpc<string>("eth_getBalance",[a,blockTag])));
  const scenario=exampleScenario(network);
  Object.assign(scenario,{demandETH:Number(formatEther(demand)),availableETH:Number(formatEther(BigInt(balances[0])+BigInt(balances[1])+BigInt(reserve))),incomingETH,rewardsETH:0,depositLockETH:0,growthETH:0,maxRequests:500,maxExitETH:Number(limits.maxBalanceExitRequestedPerReportInEth),frameHours:Number(frameConfig.epochsPerFrame)*Number(chainConfig.slotsPerEpoch)*secondsPerSlot/3600,
    modules:modules.map(m=>({id:Number(m.id),name:m.name,exitShareBps:Number(m.priorityExitShareThreshold)})),operators,groups});
  warnings.push("Queue uses real validator indexes, predictable balances, recent exit requests and MetaRegistry at the reference state. Funding timing is a scenario: rewards and deposit lock start at zero; incoming principal is not a sweep/churn forecast. Later reports assume the same snapshot minus earlier simulated requests, with no new deposits or weight updates.");
  return {scenario,meta:{network,block:blockNumber,blockHash:payload.block_hash,refSlot,stateRoot,timestamp,keysApi:cfg.kapi,reference,validators:allKeys.length,excluded,pending:operators.reduce((n,o)=>n+o.pending,0),groups:groups.length,warnings,source:"live"}};
}
