import { AbiCoder, Interface, keccak256 } from "ethers";

export type ConsolidationNetwork = "mainnet" | "hoodi";
export const CONSOLIDATION_NETWORKS = {
  mainnet: { name: "Mainnet", chainId: 1, bus: "0xd907CE33B4Be423823d1CFFe80BD147E8b8554C8", migrator: "0x9Dc70b5A4f4F5E4AF9058C983D560564F031f1D7", locator: "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb", explorer: "https://etherscan.io", indexer: "https://eth.blockscout.com", kapi: "https://keys-api.lido.fi", deployment: 25437721, bot: "0x2eB31eE1b797C2Bf75247D39aDceF90Df1Fd9A95" },
  hoodi: { name: "Hoodi", chainId: 560048, bus: "0xe09fBcE63826468867eE66Eda491E444829E022A", migrator: "0x747d357F5b6410B80Eb63406FaC5E2A91131B4f8", locator: "0xe2EF9536DAAAEBFf5b1c130957AB3E80056b06D8", explorer: "https://hoodi.etherscan.io", indexer: "https://eth-hoodi.blockscout.com", kapi: "https://keys-api-hoodi.testnet.fi", deployment: 2681949, bot: null },
} as const;
export const BUS = new Interface([
  "event RequestsAdded(address indexed publisher,bytes batchData)", "event RequestsExecuted(bytes32 indexed batchHash,uint256 feePaid)", "event BatchesRemoved(bytes32[] batchHashes)",
  "function getBatchInfo(bytes32) view returns(tuple(address publisher,uint64 addedAt))", "function batchSize() view returns(uint256)", "function maxGroupsInBatch() view returns(uint256)", "function executionDelay() view returns(uint256)", "function getConsolidationGateway() view returns(address)",
]);
export const MIGRATOR = new Interface([
  "event ConsolidationSubmitted(uint256 indexed sourceOperatorId,uint256 indexed targetOperatorId,tuple(uint256[] sourceKeyIndices,uint256 targetKeyIndex)[] groups)",
  "function sourceModuleId() view returns(uint256)", "function targetModuleId() view returns(uint256)", "function getConsolidationBus() view returns(address)", "function getStakingRouter() view returns(address)",
]);
export const GATEWAY = new Interface(["function getConsolidationRequestLimitFullInfo() view returns(uint256 maxLimit,uint256 perFrame,uint256 frameSeconds,uint256 previous,uint256 current)", "function CONSOLIDATION_LIMIT_POSITION() view returns(bytes32)", "function isPaused() view returns(bool)"]);
export type ChainLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string; blockTimestamp?: string; removed?: boolean };
export type ConsolidationGroup = { targetPubkey: string; count: number; sourceIndices: number[] | null; targetIndex: number | null };
export type ConsolidationBatch = {
  id: string; hash: string; publisher: string; addedAt: number; block: number; logIndex: number; tx: string;
  sourceOperator: number | null; targetOperator: number | null; groups: ConsolidationGroup[]; count: number;
  status: "pending" | "executed" | "removed"; resolvedAt?: number; executionTx?: string; feeWei?: string;
};
export type Execution = { hash: string; block: number; logIndex: number; timestamp: number; batches: string[]; count: number; feeWei: string };
export type ConsolidationHistory = { batches: ConsolidationBatch[]; executions: Execution[] };
const n = (s: string | bigint) => Number(BigInt(s));
const coder = AbiCoder.defaultAbiCoder();

// Replay occurrences, rather than a hash->status ledger: an identical batch may
// be resubmitted after execution or removal. Each publication remains visible.
export function applyConsolidationLogs(history: ConsolidationHistory, logs: ChainLog[], network: ConsolidationNetwork): ConsolidationHistory {
  const cfg = CONSOLIDATION_NETWORKS[network];
  const ordered = logs.filter(l => !l.removed).sort((a,b) => n(a.blockNumber)-n(b.blockNumber) || n(a.logIndex)-n(b.logIndex));
  const pending = new Map(history.batches.filter(b => b.status === "pending").map(b => [b.hash,b]));
  const seen = new Set(history.batches.map(b => b.id));
  const executions = new Map(history.executions.map(e => [e.hash,e]));
  for (const [index,log] of ordered.entries()) {
    if (log.address.toLowerCase() !== cfg.bus.toLowerCase()) continue;
    const event = BUS.parseLog(log); if (!event) throw Error("Unknown consolidation event");
    const timestamp = log.blockTimestamp ? n(log.blockTimestamp) : NaN;
    if (!Number.isSafeInteger(timestamp)) throw Error("Consolidation event is missing a block timestamp");
    if (event.name === "RequestsAdded") {
      const id = `${log.transactionHash}:${n(log.logIndex)}`; if (seen.has(id)) continue;
      const encoded = String(event.args.batchData), hash = keccak256(encoded);
      if (pending.has(hash)) throw Error("Duplicate pending consolidation hash");
      const raw = coder.decode(["tuple(bytes[] sourcePubkeys,bytes targetPubkey)[]"],encoded)[0];
      const groups: ConsolidationGroup[] = Array.from(raw, (g: { sourcePubkeys: string[]; targetPubkey: string }) => ({ targetPubkey: g.targetPubkey, count: g.sourcePubkeys.length, sourceIndices: null, targetIndex: null }));
      let sourceOperator: number|null = null, targetOperator: number|null = null;
      const next = ordered[index+1];
      // The Migrator emits immediately after its internal Bus call. Matching
      // adjacent log indices also handles several publications in one tx.
      if (String(event.args.publisher).toLowerCase() === cfg.migrator.toLowerCase() && next?.address.toLowerCase() === cfg.migrator.toLowerCase() && next.transactionHash === log.transactionHash && n(next.logIndex) === n(log.logIndex)+1) {
        const submitted = MIGRATOR.parseLog(next);
        if (submitted?.name === "ConsolidationSubmitted") {
          if (submitted.args.groups.length !== groups.length) throw Error("Consolidation group count mismatch");
          sourceOperator = Number(submitted.args.sourceOperatorId); targetOperator = Number(submitted.args.targetOperatorId);
          groups.forEach((group,i) => { const g=submitted.args.groups[i]; if (g.sourceKeyIndices.length !== group.count) throw Error("Consolidation source count mismatch"); group.sourceIndices=Array.from(g.sourceKeyIndices, Number); group.targetIndex=Number(g.targetKeyIndex); });
        }
      }
      const batch: ConsolidationBatch = { id, hash, publisher: String(event.args.publisher), addedAt: timestamp, block: n(log.blockNumber), logIndex: n(log.logIndex), tx: log.transactionHash, sourceOperator, targetOperator, groups, count: groups.reduce((sum,g)=>sum+g.count,0), status:"pending" };
      history.batches.push(batch); pending.set(hash,batch); seen.add(id);
    } else if (event.name === "RequestsExecuted") {
      const hash=String(event.args.batchHash), batch=pending.get(hash);
      if (!batch) throw Error("Execution has no preceding consolidation publication");
      batch.status="executed"; batch.resolvedAt=timestamp; batch.executionTx=log.transactionHash; batch.feeWei=String(event.args.feePaid); pending.delete(hash);
      const tx=executions.get(log.transactionHash) ?? { hash:log.transactionHash, block:n(log.blockNumber), logIndex:n(log.logIndex), timestamp, batches:[], count:0, feeWei:"0" };
      tx.batches.push(batch.id); tx.count+=batch.count; tx.feeWei=String(BigInt(tx.feeWei)+event.args.feePaid); executions.set(tx.hash,tx);
    } else if (event.name === "BatchesRemoved") {
      for (const hash of event.args.batchHashes) { const batch=pending.get(String(hash)); if(!batch)throw Error("Removal has no preceding consolidation publication"); batch.status="removed"; batch.resolvedAt=timestamp; pending.delete(String(hash)); }
    }
  }
  history.executions=[...executions.values()].sort((a,b)=>a.block-b.block || a.logIndex-b.logIndex);
  history.batches.sort((a,b)=>a.block-b.block || a.logIndex-b.logIndex);
  return history;
}

export type ConsolidationLimit = { max: number; perFrame: number; frameSeconds: number; previous: number; current: number | null; previousTimestamp: number; unlimited: boolean };
export function unpackLimit(storage: string, current: number | null): ConsolidationLimit {
  const packed=BigInt(storage), read=(shift:number)=>Number((packed>>BigInt(shift))&0xffffffffn);
  return { max:read(0), previous:read(32), previousTimestamp:read(64), frameSeconds:read(96), perFrame:read(128), current, unlimited:read(0)===0 };
}
export function quotaAt(limit: ConsolidationLimit, timestamp: number): number {
  if(limit.unlimited)return Infinity;
  const frames=limit.frameSeconds>0 ? Math.floor(Math.max(0,timestamp-limit.previousTimestamp)/limit.frameSeconds) : 0;
  return Math.min(limit.max,limit.previous+frames*limit.perFrame);
}
export type BatchEstimate = { at: number|null; reason: string; quotaAtExecution: number|null };
export function estimateBatch(batch: Pick<ConsolidationBatch,"count"|"addedAt">, limit: ConsolidationLimit, delay: number, now: number, blockers: string[]=[]): BatchEstimate {
  if(blockers.length)return {at:null,reason:blockers.join(" · "),quotaAtExecution:null};
  let at=Math.max(now,batch.addedAt+delay);
  if(!limit.unlimited && batch.count>limit.max)return {at:null,reason:"Batch exceeds quota ceiling",quotaAtExecution:null};
  if(!limit.unlimited && quotaAt(limit,at)<batch.count) {
    if(limit.perFrame===0 || limit.frameSeconds<=0)return {at:null,reason:"Quota recovery is disabled",quotaAtExecution:null};
    const frames=Math.ceil((batch.count-limit.previous)/limit.perFrame);
    at=Math.max(at,limit.previousTimestamp+frames*limit.frameSeconds);
  }
  return {at,reason:at===now?"Ready under current limits":at===batch.addedAt+delay?"Waiting for execution delay":"Waiting for quota recovery",quotaAtExecution:limit.unlimited?null:quotaAt(limit,at)};
}
export type OperatorCoverage = { id: number; name: string; deposited: number; exited: number; requested: number; pending: number; executed: number; removed: number; percent: number|null };
export function operatorCoverage(batches: ConsolidationBatch[], operators: {id:number;name:string;deposited:number;exited:number}[]): OperatorCoverage[] {
  return operators.map(op=>{
    const all=new Set<number>(), states={pending:new Set<number>(),executed:new Set<number>(),removed:new Set<number>()};
    for(const b of batches)if(b.sourceOperator===op.id)for(const g of b.groups)for(const key of g.sourceIndices??[]) {all.add(key);states[b.status].add(key);}
    if([...all].some(key=>key<0 || key>=op.deposited))throw Error("CMv1 key index exceeds deposited validator count");
    return {...op,requested:all.size,pending:states.pending.size,executed:states.executed.size,removed:states.removed.size,percent:op.deposited>0?all.size/op.deposited*100:null};
  });
}
export type ConsolidationSnapshot = {
  network: ConsolidationNetwork; block: number; blockHash: string; timestamp: number; updatedAt: number; historyFrom: number;
  bus: string; gateway: string; migrator: string; sourceModule: number; targetModule: number;
  batchSize: number; maxGroups: number; executionDelay: number; limit: ConsolidationLimit; blockers: string[];
  batches: ConsolidationBatch[]; executions: Execution[]; operators: OperatorCoverage[]; targetOperators: {id:number;name:string}[];
  bot: {address:string;balanceETH:string}|null; requestFeeWei: string|null; warnings: string[];
};
