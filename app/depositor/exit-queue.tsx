"use client";
import { DATA_REFRESH_INTERVAL_MS } from "../refresh-policy";
import { useLoadingTask } from "../loading-status";
import { rpcFetch } from "../rpc-client";

import { useEffect, useState } from "react";
import { Clock3, ExternalLink, RefreshCw } from "lucide-react";
import WithdrawalForecast from "./withdrawal-forecast";
import type { ExitQueueNetwork, ExitQueueResponse } from "../ethereum-exit-queue";

const count = (n: number | string) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const utc = (n: number) => new Date(n * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
function duration(seconds: number) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (!minutes) return "< 1 min";
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", mins ? `${mins}m` : ""].filter(Boolean).join(" ");
}

export default function EthereumExitQueue({ network, refreshKey }: { network: ExitQueueNetwork; refreshKey: number }) {
  const [result, setResult] = useState<ExitQueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      const active = new AbortController(); controller = active;
      setLoading(true);
      setNow(Math.floor(Date.now() / 1000));
      try {
        const response = await rpcFetch(`/api/depositor?network=${network}&view=exit-queue`, { signal: active.signal, cache: "no-store" });
        const body = await response.json() as ExitQueueResponse;
        if (body.network !== network || !["ready", "stale", "unavailable"].includes(body.status) ||
            (body.snapshot && body.snapshot.network !== network) || (!response.ok && body.status !== "unavailable")) throw new Error("Invalid exit queue response");
        if (!stopped && !active.signal.aborted) { setResult(body); setFailed(false); }
      } catch {
        if (!stopped && !active.signal.aborted) setFailed(true);
      } finally { if (!stopped && !active.signal.aborted) { setLoading(false); setNow(Math.floor(Date.now() / 1000)); } }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, DATA_REFRESH_INTERVAL_MS);
    return () => { stopped = true; clearInterval(timer); controller?.abort(); };
  }, [network, refreshKey]);
  // The parent keys this component by network, so a switch never shows the other chain's data.
  const snapshot = result?.snapshot;
  const stale = failed || result?.status === "stale" || (snapshot && now - snapshot.observedAt > 180);
  const usable = snapshot && now - snapshot.observedAt <= 900 ? snapshot : null;
  useLoadingTask(network,"Ethereum validator exit queue",loading,!!stale||(!loading&&!usable));
  const status = usable ? stale ? "Older snapshot" : "Live Beacon state" : loading ? "Reading Beacon state…" : "Unavailable";
  return <section id="ethereum-exit-queue" className="panel dep-exit-queue" aria-label="Ethereum validator exit queue" aria-busy={loading}>
    <header className="panel-header"><div><h2><Clock3 size={16} />Ethereum validator exit queue</h2><p>{network === "mainnet" ? "Ethereum Mainnet" : "Hoodi testnet"} · network-wide scheduled exits · Lido and other validators</p></div><span className={`dep-pill ${usable && !stale ? "good" : "neutral"}`}>{loading && <RefreshCw size={11} className="spin" />}{status}</span></header>
    {usable ? <>
      {stale && <p className="dep-exit-warning" role="status">{result?.message ?? "Refresh failed or the snapshot is old. Values below are from the displayed Beacon slot."}</p>}
      <div className="dep-queue-metrics">
        <div><span className="dep-label">Validators waiting to exit</span><strong>{count(usable.validators)}</strong><p>Active validators with an assigned future exit{usable.slashedValidators ? ` · ${count(usable.slashedValidators)} slashed` : ""}</p></div>
        <div><span className="dep-label">Effective ETH queued</span><strong>{count(usable.effectiveETH)} <small>ETH</small></strong><p>Sum of their actual effective balances, including compounding validators</p></div>
        <div><span className="dep-label">Time to last scheduled exit</span><strong>{usable.lastExitAt === null ? "No queued exits" : `≈ ${duration(usable.lastExitAt - usable.observedAt)}`}</strong><p>{usable.lastExitAt === null ? "New exits still have a protocol scheduling delay" : `Tail exits at ${utc(usable.lastExitAt)}`}</p></div>
        <div><span className="dep-label">After exit: eligibility delay</span><strong>≥ {duration(usable.withdrawalDelaySeconds)}</strong><p>Ordinary full withdrawals then wait for the withdrawal sweep; slashed validators can wait longer</p></div>
      </div>
      <WithdrawalForecast key={network} network={network} refreshKey={refreshKey} />
      <div className="dep-queue-footer dep-exit-footer">
        <p>Consolidation exits are separate: <strong>{count(usable.consolidationValidators)} validators · {count(usable.consolidationEffectiveETH)} effective ETH</strong>. They move stake to another validator and are excluded from the queue and wait above.</p>
        <details><summary>How to read this queue</summary><p>The wait runs from the observed Beacon slot to the last assigned exit epoch in this snapshot. It includes protocol scheduling and uses the chain’s actual exit schedule, rather than a fixed validators-per-day rate. It is not a quote for a new exit request and excludes requests not yet processed by consensus. Counts are network-wide, not Lido-only. Effective ETH is consensus weight, not a payout amount.</p><p>Exiting, becoming eligible to withdraw, and receiving a withdrawal are separate stages. Lido’s stETH withdrawal queue below also depends on available liquidity and oracle finalization.</p></details>
        <div className="dep-exit-source"><span>Observed {utc(usable.observedAt)} · slot {count(usable.slot)} · refreshed {utc(usable.fetchedAt)}</span>{usable.source.url ? <a href={usable.source.url} target="_blank" rel="noreferrer">{usable.source.name}<ExternalLink size={11} /></a> : <span>{usable.source.name}</span>}<a href="https://github.com/ethereum/consensus-specs/blob/master/specs/electra/beacon-chain.md#modified-initiate_validator_exit" target="_blank" rel="noreferrer">Exit rules<ExternalLink size={11} /></a></div>
      </div>
    </> : <div className="dep-exit-empty" role="status"><strong>{loading ? "Reading the network’s Beacon exit schedule" : "Exit queue data is temporarily unavailable"}</strong><p>{loading ? "Balances and exit epochs are checked against the selected network." : "Retrying every 10 minutes. An unavailable response does not mean the queue is empty."}</p><small>Source: Beacon API · {network === "mainnet" ? "Ethereum Mainnet" : "Hoodi"}{now > 0 && !loading ? ` · Last attempt ${utc(now)}` : ""}. This is separate from Lido’s stETH withdrawal queue.</small></div>}
  </section>;
}
