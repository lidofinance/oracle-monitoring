import { Interface, formatEther } from "ethers";
export const REWARD_REPORT_ABI=new Interface([
  'event ETHDistributed(uint256 indexed reportTimestamp,uint256 preCLBalance,uint256 postCLBalance,uint256 withdrawalsWithdrawn,uint256 executionLayerRewardsWithdrawn,uint256 postBufferedEther)',
  'event TokenRebased(uint256 indexed reportTimestamp,uint256 timeElapsed,uint256 preTotalShares,uint256 preTotalEther,uint256 postTotalShares,uint256 postTotalEther,uint256 sharesMintedAsFees)',
]);
/** Pair reports by transaction and timestamp. Returning principal cancels out
 * of CL P&L; it must never become a projected reward a second time. */
export function clRewardRate(logs:{transactionHash:string;topics:readonly string[];data:string}[]){
  const distributed=new Map<string,{timestamp:bigint;cl:bigint}>(),rebased=new Map<string,{timestamp:bigint;elapsed:bigint}>();
  for(const log of logs){const event=REWARD_REPORT_ABI.parseLog({topics:[...log.topics],data:log.data});if(!event)throw Error('Invalid reward report');const key=log.transactionHash.toLowerCase();
    if(event.name==='ETHDistributed'){if(distributed.has(key))throw Error('Duplicate distributed report');distributed.set(key,{timestamp:BigInt(event.args.reportTimestamp),cl:BigInt(event.args.postCLBalance)+BigInt(event.args.withdrawalsWithdrawn)-BigInt(event.args.preCLBalance)});}
    else if(event.name==='TokenRebased'){if(rebased.has(key))throw Error('Duplicate rebase report');rebased.set(key,{timestamp:BigInt(event.args.reportTimestamp),elapsed:BigInt(event.args.timeElapsed)});}
    else throw Error('Unexpected reward report');
  }
  if(!distributed.size||distributed.size!==rebased.size)throw Error('Incomplete reward reports');
  let cl=0n,seconds=0n;
  for(const [key,report]of distributed){const rebase=rebased.get(key);if(!rebase||rebase.timestamp!==report.timestamp||rebase.elapsed<=0n)throw Error('Mismatched reward reports');cl+=report.cl;seconds+=rebase.elapsed;}
  return {dailyCLETH:Math.max(0,Number(formatEther(cl))*86400/Number(seconds)),netCLETH:formatEther(cl),seconds:Number(seconds),reports:distributed.size};
}
export type LiquidityExit={index:number;balanceETH:string;cappedETH:string;excessETH:string;withdrawableAt:number};
export type LiquiditySnapshot={network:'mainnet'|'hoodi';timestamp:number;slot:number;block:number;bufferETH:string;demandETH:string;currentDepositLockETH:string;depositTargetETH:string;maxWithdrawalETH:string;accountingFrameSeconds:number;withdrawalVaultETH:string;elVaultETH:string;exits:LiquidityExit[]};
export type LiquidityResponse={network:'mainnet'|'hoodi';status:'loading'|'ready'|'unavailable';snapshot:LiquiditySnapshot|null};
export function liquidityModel(snapshot:LiquiditySnapshot,waitSeconds:number,sweepSeconds:number,dailyCLETH:number,dailyELETH:number){
  const amounts=[waitSeconds,sweepSeconds,dailyCLETH,dailyELETH,Number(snapshot.bufferETH),Number(snapshot.demandETH),Number(snapshot.currentDepositLockETH),Number(snapshot.depositTargetETH),Number(snapshot.maxWithdrawalETH),Number(snapshot.withdrawalVaultETH),Number(snapshot.elVaultETH)];
  if(amounts.some(v=>!Number.isFinite(v)||v<0)||!Number.isSafeInteger(snapshot.accountingFrameSeconds)||snapshot.accountingFrameSeconds<1||!Number.isSafeInteger(snapshot.timestamp)||snapshot.timestamp<0||!Array.isArray(snapshot.exits)||snapshot.exits.some(v=>[Number(v.cappedETH),Number(v.excessETH),v.withdrawableAt].some(n=>!Number.isFinite(n)||n<0))||waitSeconds>365*86400)throw Error('Invalid liquidity model');
  const horizonAt=snapshot.timestamp+waitSeconds;
  const eligible=snapshot.exits.filter(v=>Math.max(snapshot.timestamp,v.withdrawableAt)+sweepSeconds/2<=horizonAt);
  const exitETH=eligible.reduce((sum,v)=>sum+Number(v.cappedETH),0),exitExcessETH=eligible.reduce((sum,v)=>sum+Number(v.excessETH),0);
  const frames=Math.floor(waitSeconds/snapshot.accountingFrameSeconds);
  // Ejector average-case future lock: half of min(target, max WR) per full AO frame.
  const futureDepositLockETH=frames*Math.min(Number(snapshot.depositTargetETH),Number(snapshot.maxWithdrawalETH))/2;
  const depositLockETH=Number(snapshot.currentDepositLockETH)+futureDepositLockETH;
  const clETH=dailyCLETH*waitSeconds/86400+exitExcessETH,elETH=dailyELETH*waitSeconds/86400;
  const vaultsETH=Number(snapshot.withdrawalVaultETH)+Number(snapshot.elVaultETH),bufferETH=Number(snapshot.bufferETH);
  const requiredETH=Number(snapshot.demandETH)+depositLockETH,incomingETH=bufferETH+vaultsETH+exitETH+clETH+elETH;
  return {horizonAt,frames,futureDepositLockETH,depositLockETH,exitETH,exitExcessETH,exits:eligible.length,totalExits:snapshot.exits.length,clETH,elETH,vaultsETH,bufferETH,requiredETH,incomingETH,netETH:incomingETH-requiredETH};
}
