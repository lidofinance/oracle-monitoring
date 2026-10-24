"use client";

import { ExternalLink } from "lucide-react";
import { useExitForecast } from "./use-exit-forecast";
const number=(n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:0});
const utc=(n:number)=>new Date(n*1000).toISOString().replace('T',' ').slice(0,16)+' UTC';
function duration(seconds:number){const minutes=Math.round(Math.max(0,seconds)/60);if(!minutes)return '< 1 min';const d=Math.floor(minutes/1440),h=Math.floor(minutes%1440/60),m=minutes%60;return [d?`${d}d`:'',h?`${h}h`:'',m?`${m}m`:''].filter(Boolean).join(' ');}

export default function WithdrawalForecast({network,refreshKey}:{network:'mainnet'|'hoodi';refreshKey:number}){
  const {result,failed,now}=useExitForecast(network,refreshKey);
  const timing=result?.timing && now-result.timing.observedAt<1200?result.timing:null;
  const inflow=result?.inflow && now-result.inflow.to<1800?result.inflow:null;
  const loadingTiming=!failed&&(!result||result.timingStatus==='loading'),loadingInflow=!failed&&(!result||result.inflowStatus==='loading');
  const wait=timing?timing.averageWithdrawalAt-timing.observedAt:null;
  const daily=inflow?inflow.dailySweepETH+inflow.dailyELRewardsETH:null;
  const projected=wait!==null&&daily!==null?daily*wait/86400:null;
  return <div className="dep-withdrawal-forecast" aria-label="Exit now withdrawal timing and Lido inflow">
    <div className="dep-forecast-heading"><h3>Exit now → ETH received</h3><span>32 ETH · ordinary full exit · estimate</span></div>
    {failed&&<p className="dep-forecast-status" role="status">Refresh failed. Displayed estimates use the snapshot times below.</p>}
    <div className="dep-forecast-grid">
      <div className="dep-forecast-timing">
        <span className="dep-label">Estimated total wait</span>
        <strong>{wait===null?loadingTiming?'Calculating…':'Unavailable':`≈ ${duration(wait)}`}</strong>
        {timing?<>
          <p>Average sweep position · expected around <b>{utc(timing.averageWithdrawalAt)}</b></p>
          <p className="dep-forecast-range">Estimated window: {duration(timing.eligibleAt-timing.observedAt)} – {duration(timing.lateWithdrawalAt-timing.observedAt)} from the snapshot</p>
          <ol className="dep-forecast-stages">
            <li><span>Exit queue</span><b>{duration(timing.exitAt-timing.observedAt)}</b></li>
            <li><span>Eligibility delay</span><b>{duration(timing.withdrawalDelaySeconds)}</b></li>
            <li><span>Sweep wait · average</span><b>≈ {duration(timing.sweepCycleSeconds/2)}</b></li>
            <li><span>Full sweep cycle · active CL model</span><b>≈ {duration(timing.sweepCycleSeconds)}</b></li>
          </ol>
          <p><b>After the validator exits:</b> ≈ {duration(timing.withdrawalDelaySeconds+timing.sweepCycleSeconds/2)} until payout, including the sweep.</p>
        </>:<p>{loadingTiming?'Reading exit capacity and counting active CL validators.':'A reliable current sweep estimate is unavailable. Retrying automatically.'}</p>}
      </div>
      <div className="dep-forecast-inflow">
        <span className="dep-label">Average Lido incoming · last 7 days</span>
        <strong>{daily===null?loadingInflow?'Calculating…':'Unavailable':number(daily)}{daily!==null&&<small> ETH / day</small>}</strong>
        {inflow?<>
          <dl><div><dt>Validator sweeps</dt><dd>{number(inflow.dailySweepETH)} ETH / day</dd></div><div><dt>EL proposal rewards</dt><dd>{number(inflow.dailyELRewardsETH)} ETH / day</dd></div></dl>
          <div className="dep-forecast-projection"><span>Incoming during the estimated wait</span><b>{projected===null?'—':`≈ ${number(projected)} ETH`}</b><p>{wait===null?'Available once the timing estimate is ready.':`${number(wait/86400*inflow.dailySweepETH)} ETH sweeps + ${number(wait/86400*inflow.dailyELRewardsETH)} ETH EL rewards, if the recent daily rate continues.`}</p></div>
        </>:<p>{loadingInflow?'Reconciling Lido vault arrivals and collected ETH.':'Recent vault inflows could not be verified. No zero income is assumed.'}</p>}
      </div>
    </div>
    <details className="dep-forecast-method"><summary>Timing and inflow methodology</summary>
      <p>The exit is assumed to be processed by consensus at the displayed slot. Its 32 ETH scheduling uses the state’s actual earliest exit epoch and remaining exit capacity. The protocol eligibility delay follows that exit. A full sweep cycle is modeled as one payout per currently active CL validator at the network’s maximum withdrawals per payload and slot duration. The active set includes ongoing, exiting and slashed validators until their exit epoch, including 0x02 compounding validators; pending and already-exited validators are excluded. An unknown position uses half a cycle on average. This is a planning estimate, not a maximum: skipped or compounding validators can shorten it; missed blocks, pending partial withdrawals and already-exited validators awaiting payment can lengthen it. Message inclusion before consensus processing, slashing delays, and Lido stETH request finalization are separate.</p>
      <p>Incoming ETH is measured at Lido’s Withdrawal Vault and EL Rewards Vault: closing balance minus opening balance plus ETH collected by Lido during the seven-day sample. Validator sweeps include returned principal and consensus rewards; EL rewards include proposal tips and MEV paid into the rewards vault. These are gross ETH inflows, not staking profit. The wait-period total extrapolates the observed daily rate; it does not predict future exits or proposal assignments.</p>
      {timing&&<p>Beacon snapshot {utc(timing.observedAt)} · slot {number(timing.slot)} · {number(timing.activeValidators)} active CL validators ÷ {number(timing.withdrawalsPerPayload)} withdrawals per payload × {number(timing.secondsPerSlot)} seconds per slot · estimated full cycle {duration(timing.sweepCycleSeconds)}.</p>}
      {inflow&&<p>Inflow sample {utc(inflow.from)} → {utc(inflow.to)}. <a href={`${inflow.explorer}/address/${inflow.withdrawalVault}`} target="_blank" rel="noreferrer">Withdrawal Vault <ExternalLink size={10}/></a> · <a href={`${inflow.explorer}/address/${inflow.elRewardsVault}`} target="_blank" rel="noreferrer">EL Rewards Vault <ExternalLink size={10}/></a></p>}
      <p><a href="https://launchpad.ethereum.org/withdrawals" target="_blank" rel="noreferrer">Ethereum withdrawal stages <ExternalLink size={10}/></a> · <a href="https://github.com/ethereum/consensus-specs/blob/master/specs/electra/beacon-chain.md#new-compute_exit_epoch_and_update_churn" target="_blank" rel="noreferrer">Exit scheduling rules <ExternalLink size={10}/></a></p>
    </details>
  </div>;
}
