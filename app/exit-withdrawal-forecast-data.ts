/** Fixed section of Electra/Fulu BeaconState SSZ. Field order follows the consensus specs. */
export function beaconStateLayout(spec: Record<string, string>, version: string) {
  if (!["electra", "fulu"].includes(version)) throw Error("Unsupported Beacon state fork");
  const n = (key: string) => { const value = Number(spec[key]); if (!Number.isSafeInteger(value) || value <= 0) throw Error("Invalid Beacon preset"); return value; };
  const fields: [string, number][] = [
    ["genesis",8],["genesisRoot",32],["slot",8],["fork",16],["header",112],
    ["blockRoots",n("SLOTS_PER_HISTORICAL_ROOT")*32],["stateRoots",n("SLOTS_PER_HISTORICAL_ROOT")*32],
    ["historicalRoots",4],["eth1Data",72],["eth1Votes",4],["depositIndex",8],["validators",4],["balances",4],
    ["randao",n("EPOCHS_PER_HISTORICAL_VECTOR")*32],["slashings",n("EPOCHS_PER_SLASHINGS_VECTOR")*8],
    ["previousParticipation",4],["participation",4],["bits",1],["checkpoints",120],["inactivity",4],
    ["syncCommittees",2*(n("SYNC_COMMITTEE_SIZE")*48+48)],["payload",4],["withdrawalIndex",8],["cursor",8],
    ["summaries",4],["depositRequests",8],["depositBalance",8],["exitBalance",8],["earliestExit",8],
    ["consolidationBalance",8],["earliestConsolidation",8],["pendingDeposits",4],["pendingPartial",4],["pendingConsolidation",4],
  ];
  if (version === "fulu") fields.push(["lookahead",(n("MIN_SEED_LOOKAHEAD")+1)*n("SLOTS_PER_EPOCH")*8]);
  const offsets: Record<string,number> = {}; let size = 0;
  for (const [field, length] of fields) { offsets[field] = size; size += length; }
  if (size > 4*1024*1024) throw Error("Unsupported Beacon preset size");
  return { offsets, size };
}
export function parseBeaconStatePrefix(bytes: Uint8Array, spec: Record<string,string>, version: string, expected: { slot: number; genesisRoot: string; genesisTime: number }) {
  const { offsets: o, size } = beaconStateLayout(spec,version);
  if (bytes.byteLength < size) throw Error("Incomplete Beacon state prefix");
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const u64 = (name: string) => view.getBigUint64(o[name],true);
  const safe = (name: string) => { const value = Number(u64(name)); if (!Number.isSafeInteger(value)) throw Error("Unsafe Beacon state integer"); return value; };
  const offset = (name: string) => view.getUint32(o[name],true);
  const root = "0x" + Array.from(bytes.slice(o.genesisRoot,o.genesisRoot+32),x=>x.toString(16).padStart(2,"0")).join("");
  const validatorsBytes = offset("balances")-offset("validators");
  const validators = validatorsBytes/121;
  const variables = ["historicalRoots","eth1Votes","validators","balances","previousParticipation","participation","inactivity","payload","summaries","pendingDeposits","pendingPartial","pendingConsolidation"].map(offset);
  if (root !== expected.genesisRoot || safe("slot") !== expected.slot || safe("genesis") !== expected.genesisTime ||
      offset("historicalRoots") !== size || variables.some((v,i)=>v<size || (i>0 && v<variables[i-1])) ||
      !Number.isSafeInteger(validators) || validators < 1 ||
      offset("previousParticipation")-offset("balances") !== validators*8 || safe("cursor") >= validators) throw Error("Inconsistent Beacon state layout");
  return { validators, cursor:safe("cursor"), earliestExitEpoch:safe("earliestExit"), exitBalanceToConsume:u64("exitBalance") };
}

/** Exact scheduling for a 32 ETH ordinary exit processed at the snapshot.
 * 32 ETH fits in one epoch's minimum Electra churn (128 ETH), even on Hoodi. */
export function newExitEpoch(epoch: number, earliest: number, remainingGwei: bigint, maxSeedLookahead: number) {
  for (const n of [epoch,earliest,maxSeedLookahead]) if (!Number.isSafeInteger(n) || n<0) throw Error("Invalid exit schedule");
  if (remainingGwei<0n) throw Error("Invalid remaining exit capacity");
  const base = epoch+1+maxSeedLookahead;
  return Math.max(base,earliest) + (earliest>=base && remainingGwei<32_000_000_000n ? 1 : 0);
}
/** Count the actual active set (activation_epoch <= epoch < exit_epoch) from
 * a pinned SSZ registry. Stream records without retaining the full Beacon state. */
export async function scanActiveValidatorRegistry(chunks: AsyncIterable<Uint8Array>, input: { from:number; validators:number; epoch:number }) {
  const {from,validators,epoch}=input;
  if (![from,validators,epoch].every(n=>Number.isSafeInteger(n)&&n>=0)||!validators||!Number.isSafeInteger(from+validators*121)) throw Error("Invalid validator registry range");
  const end=from+validators*121,targetEpoch=BigInt(epoch),record=new Uint8Array(121),recordView=new DataView(record.buffer);
  let offset=0,filled=0,seen=0,active=0;
  for await (const chunk of chunks) {
    const start=Math.max(0,from-offset),stop=Math.min(chunk.length,end-offset);
    let at=start;
    while(at<stop){
      const length=Math.min(121-filled,stop-at);record.set(chunk.subarray(at,at+length),filled);filled+=length;at+=length;
      if(filled===121){
        if(recordView.getBigUint64(97,true)<=targetEpoch&&targetEpoch<recordView.getBigUint64(105,true))active++;
        seen++;filled=0;
      }
    }
    offset+=chunk.length;
    if(offset>=end){if(seen!==validators||filled)throw Error("Incomplete validator registry");return active;}
  }
  throw Error("Truncated validator registry");
}

/** Planning model: one payout per currently active CL validator at the payload
 * limit. Includes compounding validators; it is not a guaranteed maximum. */
export function activeValidatorSweepSeconds(input: { activeValidators:number; withdrawalsPerPayload:number; secondsPerSlot:number }) {
  if(Object.values(input).some(n=>!Number.isSafeInteger(n)||n<=0))throw Error("Invalid sweep capacity");
  return Math.ceil(input.activeValidators/input.withdrawalsPerPayload)*input.secondsPerSlot;
}
/** Vault balance change + transfers collected by Lido = arrivals, without
 * counting the same ETH twice when an oracle moves it out of the vault. */
export function vaultInflow(startWei: bigint, endWei: bigint, collectedWei: bigint) {
  if ([startWei,endWei,collectedWei].some(n=>n<0n)) throw Error("Invalid vault accounting");
  const value=endWei-startWei+collectedWei;
  if (value<0n) throw Error("Incomplete vault accounting");
  return value;
}
export type WithdrawalTiming = {
  observedAt:number; slot:number; exitAt:number; eligibleAt:number; averageWithdrawalAt:number; lateWithdrawalAt:number;
  withdrawalDelaySeconds:number; sweepCycleSeconds:number; sweepMethod:"active-validators";
  activeValidators:number; withdrawalsPerPayload:number; secondsPerSlot:number;
};
export type LidoInflow = { from:number; to:number; sweepETH:string; elRewardsETH:string; dailySweepETH:number; dailyELRewardsETH:number; dailyCLETH:number|null; clReports:number; withdrawalVault:string; elRewardsVault:string; explorer:string };
export type ExitWithdrawalForecast = {
  network:"mainnet"|"hoodi"; status:"loading"|"ready"; updatedAt:number;
  timing:WithdrawalTiming|null; inflow:LidoInflow|null; timingStatus:"loading"|"ready"|"unavailable"; inflowStatus:"loading"|"ready"|"unavailable";
};
