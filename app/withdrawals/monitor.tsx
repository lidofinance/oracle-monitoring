"use client";
import { DATA_REFRESH_INTERVAL_MS } from "../refresh-policy";
import { useLoadingTask } from "../loading-status";
import { rpcFetch } from "../rpc-client";
import { useCallback,useEffect,useRef,useState } from "react";
import { ArrowUpFromLine,ExternalLink,RefreshCw,ShieldCheck } from "lucide-react";
import SiteHeader, { NetworkBar } from "../site-header";
import EthereumExitQueue from "../depositor/exit-queue";
import LiquidityBalance from "../depositor/liquidity-balance";
import BufferPanel from "../depositor/buffer-panel";
import WithdrawalQueue from "./withdrawal-queue";
import { withdrawalDays } from "../withdrawals-data";
import type { DepositorSnapshot } from "../depositor-data";
import "../depositor/style.css";
import "./style.css";
type Network='mainnet'|'hoodi';
const number=(v:string|number,digits=0)=>Number(v).toLocaleString('en-US',{maximumFractionDigits:digits});
const utc=(n:number)=>new Date(n*1000).toISOString().replace('T',' ').slice(0,19)+' UTC';
const short=(s:string)=>`${s.slice(0,10)}…${s.slice(-6)}`;
export default function WithdrawalsMonitor({initialNetwork}:{initialNetwork:Network}){
 const [network,setNetwork]=useState<Network>(initialNetwork),[data,setData]=useState<DepositorSnapshot|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null),[now,setNow]=useState(0),[refreshKey,setRefreshKey]=useState(0),[shown,setShown]=useState(15);
 useLoadingTask(network,"Withdrawal queue and finalizations",loading,!!error||!!data?.warnings.length);
 const controller=useRef<AbortController|null>(null);
 useEffect(()=>{const timer=setInterval(()=>setNow(Math.floor(Date.now()/1000)),30000);return()=>clearInterval(timer);},[]);
 const load=useCallback(async()=>{
  setLoading(true);
  controller.current?.abort();const active=new AbortController();controller.current=active;
  try{const response=await rpcFetch(`/api/depositor?network=${network}&v=daily-buffer`,{signal:active.signal});const body=await response.json() as DepositorSnapshot&{error?:string};if(!response.ok||body.network!==network)throw Error(body.error??'Withdrawal data is temporarily unavailable.');if(!active.signal.aborted){setData(body);setError(null);setNow(Math.floor(Date.now()/1000));}}
  catch(e){if(!active.signal.aborted)setError(e instanceof Error?e.message:'Withdrawal data is unavailable.');}
  finally{if(!active.signal.aborted)setLoading(false);}
 },[network]);
 useEffect(()=>{const initial=setTimeout(()=>void load(),0);const timer=setInterval(()=>{if(!document.hidden)void load();},DATA_REFRESH_INTERVAL_MS);return()=>{clearTimeout(initial);clearInterval(timer);controller.current?.abort();};},[load]);
 const snapshot=data?.network===network?data:null;
 const changeNetwork=(n:Network)=>{if(n===network)return;setData(null);setError(null);setShown(15);setLoading(true);setNetwork(n);window.history.replaceState(null,'',`/withdrawals?network=${n}`);};
 const days=withdrawalDays(snapshot?.withdrawals??[],now),finalizedETH=days.reduce((n,d)=>n+d.eth,0),finalizedRequests=days.reduce((n,d)=>n+d.requests,0);
 const events=[...(snapshot?.withdrawals??[])].sort((a,b)=>b.timestamp-a.timestamp||b.block-a.block);
 const max=Math.max(...days.map(d=>d.eth),1),complete=snapshot?.withdrawalsComplete===true;
 return <main className="app-shell dep-shell withdrawal-shell">
  <SiteHeader network={network} title="Lido Withdrawal Watch" subtitle="Exit queues · liquidity · finalizations" icon={<ArrowUpFromLine size={18}/>} actions={<><span className="updated">{snapshot?`Updated ${utc(snapshot.updatedAt).slice(11)}`:'Reading withdrawals…'}</span><button className="refresh-button" type="button" disabled={loading} onClick={()=>{setLoading(true);void load();setRefreshKey(n=>n+1);}}><RefreshCw size={14} className={loading?'spin':''}/>Refresh</button></>}/>
  <NetworkBar network={network} onChange={changeNetwork} label="Withdrawal network"/>
  <div className="workspace dep-workspace">
   <div className="dep-heading"><div><div className="eyebrow">WITHDRAWALS / {network.toUpperCase()}</div><h1>From exit to claim.</h1><p>Follow withdrawal demand, expected ETH arrivals and completed finalizations.</p></div><span className="dep-readonly"><ShieldCheck size={14}/>Public chain data · refreshes every 10 minutes</span></div>
   {error&&<div className="report-warning" role="alert">{error} {snapshot?'Showing the last successful snapshot; retrying automatically.':'Retrying automatically.'}</div>}
   <section className="dep-metrics" aria-label="Withdrawal summary">{[
    {label:'Withdrawal demand',value:snapshot?.withdrawalQueue.demand,unit:'stETH',detail:'Requested stETH awaiting finalization'},
    {label:'Pending requests',value:snapshot?.withdrawalQueue.pendingRequests,unit:'requests',detail:'Submitted requests not yet finalized'},
    {label:'Ready to claim',value:snapshot?.withdrawalQueue.claimableEther,unit:'ETH',detail:'Finalized ETH not yet claimed by request owners'},
    {label:'Finalized · 7 UTC days',value:snapshot?finalizedETH:null,unit:'ETH',detail:snapshot?`${complete?'':'At least '}${number(finalizedRequests)} requests finalized · includes today`:'ETH made claimable over seven calendar days',partial:!complete},
   ].map(m=><article key={m.label} className="dep-metric"><span>{m.label}</span><strong>{m.value===null||m.value===undefined?'—':`${m.partial?'≥ ':''}${number(m.value,m.unit==='requests'?0:2)}`}<small>{m.unit}</small></strong><p>{m.detail}</p></article>)}</section>
   <EthereumExitQueue key={`exits-${network}`} network={network} refreshKey={refreshKey}/>
   <LiquidityBalance key={`funding-${network}`} network={network} refreshKey={refreshKey}/>
   {snapshot?<>
    {snapshot.warnings.filter(w=>/withdraw|histor|head|buffer/i.test(w)).map(w=><div className="report-warning" key={w}>{w}</div>)}
    <WithdrawalQueue data={snapshot}/>
    <div className="withdrawal-buffer"><BufferPanel key={network} data={snapshot} network={network} refreshKey={refreshKey}/></div>
    <section id="finalizations" className="panel withdrawal-finalizations"><header className="panel-header"><div><h2>Daily withdrawal finalizations</h2><p>ETH made claimable · seven UTC calendar days · today is partial</p></div><span className="dep-pill neutral">{complete?'Complete loaded ranges':'Incomplete history'}</span></header><div className="withdrawal-bars" role="img" aria-label="Daily finalized ETH and withdrawal request counts over seven UTC days">{days.map(d=><div key={d.timestamp}><strong>{complete?'':'≥'}{number(d.eth)}</strong><div className="withdrawal-bar-track"><i style={{height:`${d.eth/max*100}%`}} title={`${complete?'':'At least '}${number(d.eth,2)} ETH · ${number(d.requests)} requests · ${d.reports} finalizations`}/></div><span>{new Date(d.timestamp*1000).toISOString().slice(5,10)}</span><small>{complete?'':'≥'}{number(d.requests)} requests</small></div>)}</div></section>
    <section id="finalization-history" className="panel dep-ledger"><header className="panel-header"><div><h2>Finalization history</h2><p>Oracle finalizations lock ETH for request owners · latest first</p></div><span className="dep-count">{events.length} events</span></header><div className="table-scroll"><table className="dep-transactions"><thead><tr><th>Transaction / UTC time</th><th>Request IDs</th><th>Requests</th><th>ETH locked</th><th>Block</th></tr></thead><tbody>{events.slice(0,shown).map(e=><tr key={`${e.hash}-${e.firstRequestId}`}><td><a className="dep-tx-link" href={`${snapshot.explorer}/tx/${e.hash}`} target="_blank" rel="noreferrer">{short(e.hash)}<ExternalLink size={11}/></a><small>{utc(e.timestamp)}</small></td><td>{number(e.firstRequestId)} – {number(e.lastRequestId)}</td><td>{number(e.requests)}</td><td className="dep-numeric">{number(e.amount,2)} ETH</td><td><a href={`${snapshot.explorer}/block/${e.block}`} target="_blank" rel="noreferrer">{number(e.block)}</a></td></tr>)}</tbody></table></div>{!events.length&&<div className="dep-empty">{complete?'No finalizations in the loaded period.':'Finalization history is unavailable or incomplete.'}</div>}{events.length>shown&&<button className="dep-more" type="button" onClick={()=>setShown(n=>n+15)}>Show 15 more</button>}</section>
   </>:<section className="panel dep-exit-empty" role="status"><strong>{loading?'Reading withdrawal demand, buffer history and finalizations':'Withdrawal snapshot is unavailable'}</strong><p>Live queue and funding estimates above load independently. Missing data is not shown as zero.</p></section>}
   <section className="panel withdrawal-lifecycle"><header className="panel-header"><div><h2>How a Lido withdrawal progresses</h2><p>A validator exit and a stETH withdrawal request are different queues.</p></div></header><ol><li><b>1 · Requested</b><p>The request enters Lido’s FIFO queue. Available buffer and vault ETH can help fulfill it without a new validator exit.</p></li><li><b>2 · Finalized</b><p>An oracle report locks the corresponding ETH. Finalization depends on available liquidity, accounting and safety checks.</p></li><li><b>3 · Claimed</b><p>Once finalized, the request owner claims the ETH. “Ready to claim” is already reserved and is excluded from the funding forecast.</p></li></ol><p className="withdrawal-help"><a href="https://docs.lido.fi/contracts/withdrawal-queue-erc721/" target="_blank" rel="noreferrer">Withdrawal queue documentation<ExternalLink size={11}/></a></p></section>
   <footer className="dep-footer"><span>Lido Withdrawal Watch · Independent public-data monitor</span><span>Forecasts are estimates · All times UTC</span></footer>
  </div>
 </main>;
}
