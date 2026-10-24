"use client";
import { ExternalLink } from "lucide-react";
import { Address, Gate } from "../depositor/ui";
import type { DepositorSnapshot } from "../depositor-data";
const number=(value:string|number,digits=2)=>Number(value).toLocaleString("en-US",{maximumFractionDigits:digits,minimumFractionDigits:digits});
const date=(timestamp:number)=>new Date(timestamp*1000).toISOString().replace("T"," ").slice(0,19)+" UTC";
export default function WithdrawalQueue({data}:{data:DepositorSnapshot}){
 const withdrawalEvents=data.withdrawals??[];
 return <section className="panel dep-withdrawal-queue" aria-label="Withdrawal queue information">
          <header id="withdrawal-queue" className="panel-header"><div><h2>Withdrawal queue</h2><p>Pending stETH demand and ETH ready to claim</p></div><Address value={data.addresses.withdrawalQueue} explorer={data.explorer} /></header>
          <div className="dep-queue-metrics">
            <div><span className="dep-label">Withdrawal demand</span><strong>{data.withdrawalQueue.demand === null ? "—" : number(data.withdrawalQueue.demand, Number(data.withdrawalQueue.demand) > 0 && Number(data.withdrawalQueue.demand) < 0.01 ? 8 : 2)} <small>stETH</small></strong><p>Requested stETH awaiting finalization</p></div>
            <div><span className="dep-label">Pending requests</span><strong>{data.withdrawalQueue.pendingRequests === null ? "—" : number(data.withdrawalQueue.pendingRequests, 0)}</strong><p>Requests not yet finalized</p></div>
            <div><span className="dep-label">Ready to claim</span><strong>{data.withdrawalQueue.claimableEther === null ? "—" : number(data.withdrawalQueue.claimableEther)} <small>ETH</small></strong><p>Finalized ETH that has not been claimed</p></div>
            <div><span className="dep-label">Requests finalized / submitted</span><strong>{data.withdrawalQueue.lastFinalizedRequestId === null ? "—" : number(data.withdrawalQueue.lastFinalizedRequestId, 0)} <small>/ {data.withdrawalQueue.lastRequestId === null ? "—" : number(data.withdrawalQueue.lastRequestId, 0)}</small></strong><p>Cumulative request counts</p></div>
          </div>
          <div className="dep-queue-footer"><div className="dep-gates"><Gate label="Queue unpaused" good={data.withdrawalQueue.paused === null ? null : !data.withdrawalQueue.paused} /><Gate label="Bunker mode off" good={data.withdrawalQueue.bunker === null ? null : !data.withdrawalQueue.bunker} /></div><p>Requests wait in a FIFO queue. Finalization locks ETH and makes requests claimable; owners then claim their ETH. <a href="https://docs.lido.fi/contracts/withdrawal-queue-erc721/" target="_blank" rel="noreferrer">How the queue works <ExternalLink size={11} /></a></p>{withdrawalEvents[0] && <a className="dep-last-finalization" href={`${data.explorer}/tx/${withdrawalEvents[0].hash}`} target="_blank" rel="noreferrer">Latest loaded fulfillment: {number(withdrawalEvents[0].requests, 0)} requests · {number(withdrawalEvents[0].amount)} ETH · {date(withdrawalEvents[0].timestamp)} <ExternalLink size={11} /></a>}</div>
        </section>;
}
