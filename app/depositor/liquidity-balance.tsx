"use client";
import { DATA_REFRESH_INTERVAL_MS } from "../refresh-policy";
import { useLoadingTask } from "../loading-status";
import { rpcFetch } from "../rpc-client";
import { useEffect, useState } from "react";
import { Scale, ExternalLink } from "lucide-react";
import { liquidityModel, type LiquidityResponse } from "../depositor-liquidity-data";
import { useExitForecast } from "./use-exit-forecast";
const amount=(v:number|null)=>v===null?'—':v.toLocaleString('en-US',{maximumFractionDigits:0});
const utc=(n:number)=>new Date(n*1000).toISOString().replace('T',' ').slice(0,16)+' UTC';
export default function LiquidityBalance({network,refreshKey}:{network:'mainnet'|'hoodi';refreshKey:number}){
  const {result:forecast,failed:forecastFailed,now}=useExitForecast(network,refreshKey);
  const [response,setResponse]=useState<LiquidityResponse|null>(null),[failed,setFailed]=useState(false),[fetching,setFetching]=useState(true);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const load=async()=>{let delay=DATA_REFRESH_INTERVAL_MS;setFetching(true);try{
      const r=await rpcFetch(`/api/depositor?network=${network}&view=liquidity`,{cache:'no-store',signal:controller.signal});const body=await r.json() as LiquidityResponse;
      if(!r.ok||body.network!==network||!['loading','ready','unavailable'].includes(body.status)||(body.snapshot&&body.snapshot.network!==network))throw Error('Invalid liquidity response');
      if(!controller.signal.aborted){setResponse(body);setFailed(false);}if(body.status==='loading')delay=3000;else if(body.status==='unavailable')delay=DATA_REFRESH_INTERVAL_MS;
    }catch{if(!controller.signal.aborted)setFailed(true);delay=DATA_REFRESH_INTERVAL_MS;}
    if(!controller.signal.aborted)setFetching(false);
    if(!controller.signal.aborted)timer=setTimeout(()=>{if(!document.hidden)void load();else timer=setTimeout(load,DATA_REFRESH_INTERVAL_MS);},delay);};
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[network,refreshKey]);
  const snapshot=response?.snapshot&&now-response.snapshot.timestamp<1200?response.snapshot:null;
  const timing=forecast?.timing&&now-forecast.timing.observedAt<1200?forecast.timing:null;
  const inflow=forecast?.inflow&&now-forecast.inflow.to<1800?forecast.inflow:null;
  const wait=timing?timing.averageWithdrawalAt-timing.observedAt:null;
  let model:ReturnType<typeof liquidityModel>|null=null;
  if(snapshot&&timing&&inflow?.dailyCLETH!==null&&inflow?.dailyCLETH!==undefined){
    try{model=liquidityModel(snapshot,wait!,timing.sweepCycleSeconds,inflow.dailyCLETH,inflow.dailyELRewardsETH);}catch{/* Incomplete inputs must not break the rest of the monitor. */}
  }
  const scale=Math.max(model?.requiredETH??0,model?.incomingETH??0,1);
  const rowsLeft=[{label:'Withdrawal demand',value:snapshot?Number(snapshot.demandETH):null,detail:'Unfinalized stETH · 1:1 ETH planning value'},{label:'Deposit lock',value:model?.depositLockETH??null,detail:model?`${amount(Number(snapshot!.currentDepositLockETH))} ETH current reserve + ${amount(model.futureDepositLockETH)} ETH future allowance`:'Current reserve + estimated future deposit consumption'}];
  const rowsRight=[{label:'Current buffer',value:snapshot?Number(snapshot.bufferETH):null,detail:'ETH already held by Lido'},{label:'Already in vaults',value:snapshot?Number(snapshot.withdrawalVaultETH)+Number(snapshot.elVaultETH):null,detail:'Withdrawal Vault + EL Rewards Vault'},{label:'Incoming from exits',value:model?.exitETH??null,detail:model?`${model.exits} of ${model.totalExits} pending Lido exits · capped balances`:'Scheduled exits expected within this period · excludes consolidations'},{label:'Incoming EL rewards',value:model?.elETH??null,detail:inflow?`${amount(inflow.dailyELRewardsETH)} ETH / day · last 7 days`:'Projected from recent rewards-vault arrivals'},{label:'Incoming CL rewards',value:model?.clETH??null,detail:inflow?.dailyCLETH!==null&&inflow?.dailyCLETH!==undefined?`${amount(inflow.dailyCLETH)} ETH / day · projected accrual`:'Projected from matched accounting reports'}];
  const loading=fetching||(!failed&&(!response||response.status==='loading'))||(!forecastFailed&&(!forecast||forecast.status==='loading'));
  useLoadingTask(network,"Withdrawal funding balance",loading,failed||forecastFailed||response?.status==='unavailable');
  return <section id="funding-balance" className="panel dep-liquidity" aria-label="Withdrawal demand versus available and incoming ETH" aria-busy={loading}>
    <header className="panel-header"><div><h2><Scale size={16}/>Withdrawal funding balance</h2><p>Demand + deposit lock versus current ETH + expected incoming</p></div><span className="dep-pill neutral">{wait===null?'Reading withdrawal horizon…':`Next ${(wait/86400).toLocaleString('en-US',{maximumFractionDigits:1})} days · estimate`}</span></header>
    {(failed||forecastFailed)&&<p className="dep-exit-warning">A refresh failed. Values use the displayed snapshots.</p>}
    <div className="dep-liquidity-columns">
      {[{title:'Required ETH',total:model?.requiredETH??null,rows:rowsLeft,kind:'demand'},{title:'Current + expected ETH',total:model?.incomingETH??null,rows:rowsRight,kind:'funding'}].map(side=><div className={`dep-liquidity-side ${side.kind}`} key={side.kind}><span className="dep-label">{side.title}</span><strong className="dep-liquidity-total">{amount(side.total)} <small>ETH</small></strong>{model&&<div className="dep-liquidity-composition" aria-hidden="true">{side.rows.map((row,i)=><i key={row.label} className={`part-${i}`} style={{width:`${(row.value??0)/scale*100}%`}}/>)}</div>}<dl>{side.rows.map(row=><div key={row.label}><dt>{row.label}<small>{row.detail}</small></dt><dd>{amount(row.value)} <small>ETH</small></dd></div>)}</dl></div>)}
    </div>
    <div className={`dep-liquidity-result ${model&&model.netETH>=0?'surplus':'shortfall'}`}><div><span>{model?(model.netETH>=0?'Forecast surplus':'Forecast shortfall'):loading?'Calculating the funding balance…':'Funding forecast unavailable'}</span><strong>{model?`${amount(Math.abs(model.netETH))} ETH`:'—'}</strong></div><p>{model?`Over the estimated withdrawal wait, through ${utc(model.horizonAt)}. ${model.netETH>=0?'Expected funding exceeds today’s demand and modeled deposit lock.':'Additional funding or exits would be needed if the assumptions hold.'} CL rewards may compound before becoming withdrawable.`:loading?'Reading Lido reserves, scheduled exits and recent reward reports.':'A complete, fresh snapshot is required for totals. Missing values are not treated as zero.'}</p></div>
    <details className="dep-liquidity-method"><summary>What is included</summary><p>This is a planning estimate using the same ordinary-exit withdrawal horizon as the queue widget. Demand is the current unfinalized stETH amount at a 1:1 ETH planning value; future requests and new user deposits are excluded. The right side includes current buffer and vault balances once, then adds forecast future inflows.</p><p>Deposit lock includes the current effective deposits reserve plus an average future allowance: half of min(deposits reserve target, maximum withdrawal request) for each complete accounting frame in the horizon. Using the full buffer on the right requires including its protected deposit reserve on the left.</p><p>Exit balances come from Lido keys verified through KAPI, exclude consolidation sources, and are capped at 32 ETH for 0x01 or 2,048 ETH for 0x02 validators. Only exits whose withdrawable time plus the average sweep wait falls within the period are included. Known excess above those caps is included with CL rewards rather than counted again as exit balance.</p><p>Future EL rewards use recent vault-arrival averages. Future CL rewards use matched ETHDistributed and TokenRebased accounting reports: post-CL balance + withdrawn ETH − pre-CL balance, divided by report time. Returned stake therefore does not become projected rewards. CL reward accrual can compound instead of arriving as cash within the period; the forecast is not a guarantee of immediately available ETH.</p>{snapshot&&<p>Balances and exits: {utc(snapshot.timestamp)} · block {amount(snapshot.block)} · slot {amount(snapshot.slot)}.{model&&` Deposit allowance: ${model.frames} complete accounting frames.`}</p>}{inflow&&<p>Reward baseline: {utc(inflow.from)} → {utc(inflow.to)}. {model&&`Known excess on included exits: ${amount(model.exitExcessETH)} ETH.`}</p>}<p><a href="https://github.com/lidofinance/lido-oracle/blob/master/src/modules/oracles/ejector/ejector.py" target="_blank" rel="noreferrer">Lido exit funding logic <ExternalLink size={10}/></a></p></details>
  </section>;
}
