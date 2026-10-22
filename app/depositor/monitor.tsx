"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Activity, ArrowDownToLine, ArrowUpRight, Check, Copy, ExternalLink, RefreshCw, Wallet, ShieldCheck, Clock3 } from "lucide-react";
import type { DepositorSnapshot, DepositorTransaction } from "../depositor-data";
import { displayEth } from "../depositor-format";
import { nominalVeboDays, NOMINAL_EXIT_ETH } from "../depositor-vebo";
import "./style.css";

type Network = "mainnet" | "hoodi";
const number = (value: string | number, digits = 2) => Number(value).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;
const date = (timestamp: number) => new Date(timestamp * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
function ago(timestamp: number | null, now: number) {
  if (!timestamp) return "No confirmed activity";
  const seconds = Math.max(0, now - timestamp);
  if (seconds < 60) return "Less than a minute ago";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${number(seconds / 3600, 1)} hours ago`;
  return `${number(seconds / 86400, 1)} days ago`;
}
function Address({ value, explorer, full = false }: { value: string; explorer: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  return <span className="dep-address"><a href={`${explorer}/address/${value}`} target="_blank" rel="noreferrer" title={value}>{full ? value : short(value)}<ArrowUpRight size={12} /></a><button type="button" aria-label={`Copy ${value}`} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  }}>{copied ? <Check size={12} /> : <Copy size={12} />}</button></span>;
}
function Gate({ label, good }: { label: string; good: boolean | null }) {
  return <span className={`dep-gate ${good === null ? "unknown" : good ? "good" : "bad"}`}><i />{label}<strong>{good === null ? "Unknown" : good ? "Yes" : "No"}</strong></span>;
}
function BufferChart({ points }: { points: DepositorSnapshot["history"] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const tooltipId = useId();
  if (!points.some((point) => point.buffer !== null)) return <div className="dep-empty">Historical state is currently unavailable.</div>;
  const width = 740, height = 200, left = 64, right = 16, bottom = 25, top = 12;
  const max = Math.max(...points.flatMap((point) => [Number(point.buffer), Number(point.depositable), Number(point.withdrawalDemand ?? 0)]), 1) * 1.08;
  const day = (timestamp: number) => Math.floor(timestamp / 86400) * 86400;
  const start = day(points[0].timestamp), end = day(points[points.length - 1].timestamp);
  const x = (timestamp: number) => left + (day(timestamp) - start) / Math.max(1, end - start) * (width - left - right);
  const y = (value: string | number) => height - bottom - Number(value) / max * (height - bottom - top);
  const path = (key: "buffer" | "depositable" | "withdrawalDemand", fill = false) => {
    let connected = false;
    let firstX = 0, lastX = 0;
    const close = () => fill && connected ? ` L ${lastX} ${y(0)} L ${firstX} ${y(0)} Z` : "";
    let result = "";
    for (const point of points) {
      if (point[key] === null) { result += close(); connected = false; continue; }
      const command = connected ? "L" : "M";
      if (!connected) firstX = x(point.timestamp);
      lastX = x(point.timestamp);
      connected = true;
      result += ` ${command} ${lastX} ${y(point[key])}`;
    }
    return result + close();
  };
  const inspect = (event: { currentTarget: SVGSVGElement; clientX: number; clientY: number }) => {
        const matrix = event.currentTarget.getScreenCTM();
        if (!matrix) return;
        const cursor = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        if (cursor.x < left || cursor.x > width - right || cursor.y < top || cursor.y > height - bottom) { setActiveIndex(null); return; }
        let nearest = 0;
        for (let index = 1; index < points.length; index++) {
          if (Math.abs(x(points[index].timestamp) - cursor.x) < Math.abs(x(points[nearest].timestamp) - cursor.x)) nearest = index;
        }
        setActiveIndex(nearest);
  };
  const selected = activeIndex === null ? null : points[Math.min(activeIndex, points.length - 1)];
  return <div className="dep-buffer-interactive">
    <svg className="dep-buffer-chart" viewBox={`0 0 ${width} ${height}`} role="group" tabIndex={0}
      aria-label="Daily buffer ETH, depositable ETH and withdrawal demand over seven UTC days. Hover, tap or use the arrow keys to inspect amounts rounded to whole ETH or stETH."
      aria-describedby={selected ? tooltipId : undefined}
      onPointerMove={inspect}
      onClick={inspect}
      onPointerLeave={(event) => { if (event.pointerType !== "touch") setActiveIndex(null); }}
      onFocus={() => setActiveIndex(0)}
      onBlur={() => setActiveIndex(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape") { setActiveIndex(null); return; }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Home") setActiveIndex(0);
        else if (event.key === "End") setActiveIndex(points.length - 1);
        else setActiveIndex((current) => Math.max(0, Math.min(points.length - 1, (current ?? 0) + (event.key === "ArrowRight" ? 1 : -1))));
      }}
    >
    <defs><linearGradient id="dep-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#147d5b" stopOpacity=".16" /><stop offset="100%" stopColor="#147d5b" stopOpacity=".01" /></linearGradient></defs>
    {[0, 0.5, 1].map((fraction) => <g key={fraction}><line x1={left} x2={width - right} y1={y(max * fraction)} y2={y(max * fraction)} stroke="#e6ebe6" strokeDasharray="3 4" /><text x={left - 10} y={y(max * fraction) + 3} textAnchor="end">{number(max * fraction, 0)}</text></g>)}
    <path d={path("buffer", true)} fill="url(#dep-fill)" />
    <path d={path("buffer")} fill="none" stroke="#9ba9a0" strokeWidth="2" />
    <path d={path("depositable")} fill="none" stroke="#147d5b" strokeWidth="2.5" />
    <path d={path("withdrawalDemand")} fill="none" stroke="#c47732" strokeWidth="2.5" strokeDasharray="6 3" />
    {points.map((point) => <g key={point.timestamp}>
      {point.buffer !== null && <circle cx={x(point.timestamp)} cy={y(point.buffer)} r="3" fill="#9ba9a0" />}
      {point.depositable !== null && <circle cx={x(point.timestamp)} cy={y(point.depositable)} r="3" fill="#147d5b" />}
      {point.withdrawalDemand !== null && <circle cx={x(point.timestamp)} cy={y(point.withdrawalDemand)} r="3" fill="#c47732" />}
    </g>)}
    {points.map((point, i) => <text key={point.timestamp} x={x(point.timestamp)} y={height - 5} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>{new Date(point.timestamp * 1000).toISOString().slice(5, 10)}</text>)}
    {selected && <g className="dep-chart-selection" pointerEvents="none">
      <line x1={x(selected.timestamp)} x2={x(selected.timestamp)} y1={top} y2={height - bottom} stroke="#69756f" strokeDasharray="3 3" />
      {(["buffer", "depositable", "withdrawalDemand"] as const).map((key) => selected[key] === null ? null : <circle key={key} cx={x(selected.timestamp)} cy={y(selected[key])} r="4" fill={key === "buffer" ? "#9ba9a0" : key === "depositable" ? "#147d5b" : "#c47732"} stroke="white" strokeWidth="1.5" />)}
    </g>}
    </svg>
    {selected && <div id={tooltipId} className="dep-chart-tooltip" role="tooltip" style={{ left: `clamp(8px, calc(${x(selected.timestamp) / width * 100}% - 170px), calc(100% - 348px))` }}>
      <time dateTime={new Date(selected.timestamp * 1000).toISOString()}>{new Date(selected.timestamp * 1000).toISOString().slice(0, 10)} · {day(selected.timestamp) === end ? "Latest" : "Day close"} (UTC)</time>
      {([
        ["buffer", "Buffer", "ETH"],
        ["depositable", "Depositable", "ETH"],
        ["withdrawalDemand", "Withdrawal demand", "stETH"],
      ] as const).map(([key, label, unit]) => <div className="dep-tooltip-row" key={key}>
        <span><i className={key} />{label}</span>
        <strong>{selected[key] === null ? "Unavailable" : <>{number(selected[key], 0)} <small>{unit}</small></>}</strong>
      </div>)}
    </div>}
  </div>;
}
function ActivityChart({ transactions, withdrawals, complete, veboDays, veboComplete, now }: {
  transactions: DepositorTransaction[]; withdrawals: DepositorSnapshot["withdrawals"]; complete: boolean;
  veboDays: ReturnType<typeof nominalVeboDays>; veboComplete: boolean; now: number;
}) {
  const today = Math.floor(now / 86400) * 86400;
  const days = Array.from({ length: 7 }, (_, i) => {
    const timestamp = today - (6 - i) * 86400;
    const matching = transactions.filter((tx) => tx.timestamp >= timestamp && tx.timestamp < timestamp + 86400 && tx.status === "success");
    const finalized = withdrawals.filter((event) => event.timestamp >= timestamp && event.timestamp < timestamp + 86400);
    return {
      timestamp,
      deposit: matching.filter((tx) => tx.kind === "deposit").reduce((sum, tx) => sum + Number(tx.amount ?? 0), 0),
      topup: matching.filter((tx) => tx.kind === "topup").reduce((sum, tx) => sum + Number(tx.amount ?? 0), 0),
      withdrawal: finalized.reduce((sum, event) => sum + Number(event.amount), 0),
      requests: finalized.reduce((sum, event) => sum + event.requests, 0),
      veboEth: veboDays[i].eth, veboCount: veboDays[i].requests,
    };
  });
  const max = Math.max(...days.flatMap((day) => [day.deposit + day.topup + day.withdrawal, day.veboEth]), 1);
  return <div className="dep-bars" role="img" aria-label="Daily ETH deposited, topped up and finalized for withdrawals, with fulfilled request counts and nominal VEBO exit demand, seven UTC calendar days">
    {days.map((day) => <div className="dep-bar-column" key={day.timestamp}>
      <span>{number(day.deposit + day.topup + day.withdrawal, 0)}</span>
      <div className="dep-bar-pair"><div className="dep-bar-track">
        <div className="dep-bar-deposit" style={{ height: `${day.deposit / max * 100}%` }} title={`${number(day.deposit, 0)} ETH deposits`} />
        <div className="dep-bar-topup" style={{ height: `${day.topup / max * 100}%` }} title={`${number(day.topup, 0)} ETH top-ups`} />
        <div className="dep-bar-withdrawal" style={{ height: `${day.withdrawal / max * 100}%` }} title={`${complete ? "" : "At least "}${number(day.withdrawal, 0)} ETH · ${number(day.requests, 0)} withdrawal requests fulfilled`} />
      </div><div className="dep-bar-track dep-bar-exit-track"><div className="dep-bar-vebo" style={{ height: `${day.veboEth / max * 100}%` }} title={`${veboComplete ? "" : "At least "}${number(day.veboEth, 0)} nominal ETH · ${number(day.veboCount, 0)} VEBO exit requests · ${NOMINAL_EXIT_ETH} ETH per validator`} /></div></div>
      <small>{new Date(day.timestamp * 1000).toISOString().slice(5, 10)}</small>
      <small className="dep-daily-requests" title={`${complete ? "" : "At least "}${number(day.requests, 0)} withdrawal requests fulfilled`}>{complete ? "" : "≥"}{number(day.requests, 0)} fulfilled</small>
      <small className="dep-daily-exits" title={`${veboComplete ? "" : "At least "}${number(day.veboEth, 0)} nominal ETH · ${number(day.veboCount, 0)} VEBO exit requests`}>{veboComplete ? "" : "≥"}{number(day.veboEth, 0)} ETH exits</small>
    </div>)}
  </div>;
}

export default function DepositorMonitor() {
  const [network, setNetwork] = useState<Network>("mainnet");
  const [data, setData] = useState<DepositorSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(20);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("network");
    if (requested === "hoodi") setNetwork("hoodi");
    setNow(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, []);
  const load = useCallback(async () => {
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    setLoading(true);
    try {
      const response = await fetch(`/api/depositor?network=${network}&v=daily-buffer`, { signal: active.signal });
      const snapshot = await response.json() as DepositorSnapshot & { error?: string };
      if (!response.ok) throw new Error(snapshot.error ?? "Could not load Ethereum data.");
      if (!active.signal.aborted) { setData(snapshot); setError(null); setNow(Math.floor(Date.now() / 1000)); }
    } catch (failure) {
      if (!active.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load Ethereum data.");
    } finally { if (!active.signal.aborted) setLoading(false); }
  }, [network]);
  useEffect(() => {
    setData(null); setKind("all"); setSearch(""); setShown(20);
    void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { clearInterval(timer); controller.current?.abort(); };
  }, [load]);
  const changeNetwork = (value: Network) => { setNetwork(value); window.history.replaceState(null, "", `/depositor/?network=${value}`); };
  const available = data ? Number(data.amounts.depositable) : 0;
  const buffer = data ? Number(data.amounts.buffer) : 0;
  const transactions = data?.transactions ?? [];
  const filtered = transactions.filter((tx) => (kind === "all" || tx.kind === kind) && `${tx.hash} ${tx.from} ${tx.to} ${tx.block} ${tx.modules.join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  const dailyStart = Math.floor(now / 86400) * 86400 - 6 * 86400;
  const chartTransactions = transactions.filter((tx) => tx.timestamp >= dailyStart);
  const volume = chartTransactions.reduce((sum, tx) => sum + Number(tx.amount ?? 0), 0);
  const gas = chartTransactions.reduce((sum, tx) => sum + Number(tx.gasCost), 0);
  const withdrawalEvents = data?.withdrawals ?? [];
  const chartWithdrawals = withdrawalEvents.filter((event) => event.timestamp >= dailyStart);
  const fulfilledEther = chartWithdrawals.reduce((sum, event) => sum + Number(event.amount), 0);
  const fulfilledRequests = chartWithdrawals.reduce((sum, event) => sum + event.requests, 0);
  const veboDays = nominalVeboDays(data?.veboRequests ?? [], now);
  const veboRequestedEth = veboDays.reduce((sum, day) => sum + day.eth, 0);
  const veboRequestCount = veboDays.reduce((sum, day) => sum + day.requests, 0);
  const fresh = data && now - data.updatedAt < 180 && now - data.blockTimestamp < 300 && !error;
  return <main className="app-shell dep-shell">
    <header className="topbar dep-topbar"><div className="brand"><span className="brand-mark"><ArrowDownToLine size={18} /></span><div><strong>Lido Depositor Watch</strong><span>Deposits & top-ups · Onchain monitor</span></div></div><nav className="dep-page-links"><a className="dep-oracle-link" href="https://f4ever.pl/oracle">Oracle Watch <ArrowUpRight size={14} /></a><a className="dep-oracle-link" href={`/vebo-simulator?network=${network}`}>VEBO simulator <ArrowUpRight size={14} /></a></nav><div className="top-actions"><span className="updated">{data ? `Updated ${date(data.updatedAt).slice(11)}` : "Reading Ethereum…"}</span><button className="refresh-button" type="button" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} size={14} />Refresh</button></div></header>
    <div className="context-bar"><div className="network-switch">{(["mainnet", "hoodi"] as const).map((value) => <button type="button" className={network === value ? "active" : ""} key={value} onClick={() => changeNetwork(value)} aria-pressed={network === value}><i className={`network-dot ${value}`} />{value === "mainnet" ? "Ethereum Mainnet" : "Hoodi"}<small>{value === "hoodi" ? "TESTNET" : "CHAIN 1"}</small></button>)}</div><div className="chain-state"><span><i className={fresh ? "pulse" : "dep-muted-dot"} />{fresh ? "Live onchain data" : loading ? "Loading chain data" : "Data needs refresh"}</span>{data && <a href={`${data.explorer}/block/${data.block}`} target="_blank" rel="noreferrer">Block {data.block.toLocaleString("en-US")}<ExternalLink size={11} /></a>}</div></div>
    <div className="workspace dep-workspace">
      <div className="dep-heading"><div><div className="eyebrow">LIDO OPERATIONS / {network.toUpperCase()}</div><h1>From buffer to beacon chain.</h1><p>Follow the ETH, the transactions, and the keys that keep Lido depositing.</p></div><span className="dep-readonly"><ShieldCheck size={14} />Public chain data · refreshes every minute</span></div>
      {error && <div className="report-warning" role="alert">{error} {data ? "Showing the last successful snapshot; values may be stale." : "Use Refresh to try again."}</div>}
      {loading && !data && <div className="dep-loading" role="status"><RefreshCw className="spin" size={18} /><div><strong>Reading contracts and confirmed transactions</strong><p>The first load includes seven days of activity and historical buffer samples.</p></div></div>}
      <section className="dep-metrics" aria-label="ETH balances">{[
        { label: "Depositable ETH", value: data?.amounts.depositable, detail: "Available for validator deposits and top-ups", featured: true },
        { label: "ETH in buffer", value: data?.amounts.buffer, detail: "ETH currently held in Lido’s buffer" },
        { label: "Total pooled ETH", value: data?.amounts.total, detail: "Lido’s reported total pooled ether" },
        { label: "Depositor balance", value: data?.wallets[0]?.balance, detail: data?.wallets[0]?.delegate ? "Current EDF delegate’s gas wallet" : "Current TOP_UP_ROLE holder’s gas wallet" },
      ].map((metric) => <article key={metric.label} className={`dep-metric ${metric.featured ? "featured" : ""}`}><span>{metric.label}</span><strong>{metric.value !== undefined && metric.value !== null ? number(metric.value, metric.label === "Depositor balance" ? 4 : 2) : "—"}<small>ETH</small></strong><p>{metric.detail}</p></article>)}</section>
      {data && <>
        {data.warnings.map((warning) => <div className="report-warning" key={warning}>{warning}</div>)}
        <div className="dep-status-grid">
          <section className="panel dep-operation"><header><Activity size={16} /><h2>Depositor activity</h2><span className={`dep-pill ${data.gates.depositsPaused ? "bad" : data.lastDeposit && now - data.lastDeposit.timestamp < 86400 ? "good" : "neutral"}`}>{data.gates.depositsPaused ? "DSM paused" : data.lastDeposit && now - data.lastDeposit.timestamp < 86400 ? "Recent deposit" : "No recent deposit"}</span></header><strong>{ago(data.lastDeposit?.timestamp ?? null, now)}</strong><p>Last deposit recorded by the Deposit Security Module{data.lastDeposit ? ` · ${date(data.lastDeposit.timestamp)}` : ""}.</p><div className="dep-gates"><Gate label="Lido allows deposits" good={data.gates.canDeposit} /><Gate label="DSM unpaused" good={data.gates.depositsPaused === null ? null : !data.gates.depositsPaused} /></div></section>
          <section className="panel dep-operation"><header><ArrowUpRight size={16} /><h2>Top-up activity</h2><span className={`dep-pill ${data.gates.topupPaused ? "bad" : data.lastTopup && now - data.lastTopup < 86400 ? "good" : "neutral"}`}>{data.gates.topupPaused ? "Gateway paused" : data.lastTopup && now - data.lastTopup < 86400 ? "Recent top-up" : "No recent top-up"}</span></header><strong>{ago(data.lastTopup, now)}</strong><p>Last successful operation recorded by TopUpGateway{data.lastTopup ? ` · ${date(data.lastTopup)}` : ""}.</p><div className="dep-gates"><Gate label="Gateway unpaused" good={data.gates.topupPaused === null ? null : !data.gates.topupPaused} /><Gate label="Block distance passed" good={data.gates.topupDistancePassed} /></div></section>
        </div>
        <p className="dep-context-note"><Clock3 size={13} />{available === 0 ? "No depositable ETH is currently available. " : `${number(available)} ETH is available before module allocation and guardian checks. `}Activity confirms successful onchain operations; it does not prove a bot process is online. Top-ups also need eligible validators.</p>
        <div className="dep-charts"><section className="panel"><header className="panel-header"><div><h2>Buffer over time</h2><p>Daily closes · seven UTC days · today latest · ETH / stETH</p></div><div className="dep-legend"><span><i className="buffer" />Buffer</span><span><i />Depositable</span><span><i className="withdrawal" />Withdrawal demand (stETH)</span></div></header><div className="dep-chart-wrap"><BufferChart points={data.history} /></div><div className="dep-buffer-split"><div><span>Depositable share of buffer</span><strong>{buffer > 0 ? `${number(available / buffer * 100, 1)}%` : "—"}</strong></div><div className="dep-progress"><i style={{ width: `${buffer > 0 ? Math.min(100, available / buffer * 100) : 0}%` }} /></div><small>{number(Math.max(0, buffer - available))} ETH in the buffer is unavailable for deposits under the current contract rules.</small></div></section>
        <section className="panel"><header className="panel-header"><div><h2>Daily ETH moved</h2><p>Seven UTC calendar days · ETH · fulfilled = finalized</p></div><div className="dep-legend"><span><i />Deposits</span><span><i className="topup" />Top-ups</span><span><i className="withdrawal" />Withdrawals fulfilled</span><span><i className="vebo" />VEBO exits requested (nominal)</span></div></header><ActivityChart transactions={transactions} withdrawals={withdrawalEvents} complete={data.withdrawalsComplete} veboDays={veboDays} veboComplete={data.veboComplete} now={now} /><div className="dep-volume-summary"><span><strong>{number(volume, 0)}</strong> ETH deposited / topped up</span><span><strong>{data.withdrawalsComplete ? "" : "≥"}{number(fulfilledEther, 0)}</strong> ETH withdrawals fulfilled<small>{data.withdrawalsComplete ? "" : "≥"}{number(fulfilledRequests, 0)} requests</small></span><span><strong>{data.veboComplete ? "" : "≥"}{number(veboRequestedEth, 0)}</strong> nominal ETH requested to exit<small>{data.veboComplete ? "" : "≥"}{number(veboRequestCount, 0)} VEBO requests</small></span><span><strong>{number(gas, 5)}</strong> ETH bot gas spent</span></div><p className="dep-vebo-note">VEBO demand is shown beside completed movements: {NOMINAL_EXIT_ETH} ETH × requested validators (nominal). Actual validator balances may differ. <a href={`${data.explorer}/address/${data.addresses.vebo}#events`} target="_blank" rel="noreferrer">VEBO events <ExternalLink size={11} /></a></p></section></div>
        <section className="panel dep-withdrawal-queue" aria-label="Withdrawal queue information">
          <header className="panel-header"><div><h2>Withdrawal queue</h2><p>Pending stETH demand and ETH ready to claim</p></div><Address value={data.addresses.withdrawalQueue} explorer={data.explorer} /></header>
          <div className="dep-queue-metrics">
            <div><span className="dep-label">Withdrawal demand</span><strong>{data.withdrawalQueue.demand === null ? "—" : number(data.withdrawalQueue.demand, Number(data.withdrawalQueue.demand) > 0 && Number(data.withdrawalQueue.demand) < 0.01 ? 8 : 2)} <small>stETH</small></strong><p>Requested stETH awaiting finalization</p></div>
            <div><span className="dep-label">Pending requests</span><strong>{data.withdrawalQueue.pendingRequests === null ? "—" : number(data.withdrawalQueue.pendingRequests, 0)}</strong><p>Requests not yet finalized</p></div>
            <div><span className="dep-label">Ready to claim</span><strong>{data.withdrawalQueue.claimableEther === null ? "—" : number(data.withdrawalQueue.claimableEther)} <small>ETH</small></strong><p>Finalized ETH that has not been claimed</p></div>
            <div><span className="dep-label">Requests finalized / submitted</span><strong>{data.withdrawalQueue.lastFinalizedRequestId === null ? "—" : number(data.withdrawalQueue.lastFinalizedRequestId, 0)} <small>/ {data.withdrawalQueue.lastRequestId === null ? "—" : number(data.withdrawalQueue.lastRequestId, 0)}</small></strong><p>Cumulative request counts</p></div>
          </div>
          <div className="dep-queue-footer"><div className="dep-gates"><Gate label="Queue unpaused" good={data.withdrawalQueue.paused === null ? null : !data.withdrawalQueue.paused} /><Gate label="Bunker mode off" good={data.withdrawalQueue.bunker === null ? null : !data.withdrawalQueue.bunker} /></div><p>Requests wait in a FIFO queue. Finalization locks ETH and makes requests claimable; owners then claim their ETH. <a href="https://docs.lido.fi/contracts/withdrawal-queue-erc721/" target="_blank" rel="noreferrer">How the queue works <ExternalLink size={11} /></a></p>{withdrawalEvents[0] && <a className="dep-last-finalization" href={`${data.explorer}/tx/${withdrawalEvents[0].hash}`} target="_blank" rel="noreferrer">Latest loaded fulfillment: {number(withdrawalEvents[0].requests, 0)} requests · {number(withdrawalEvents[0].amount)} ETH · {date(withdrawalEvents[0].timestamp)} <ExternalLink size={11} /></a>}</div>
        </section>
        <section className="panel dep-wallets"><header className="panel-header"><div><h2>Depositor, delegate & EDF</h2><p>Discovered live from TopUpGateway’s TOP_UP_ROLE · all current role holders</p></div><Wallet size={18} /></header>{data.wallets.length === 0 ? <div className="dep-empty">No current role holder could be discovered.</div> : data.wallets.map((wallet) => <div className="dep-wallet" key={wallet.holder}><div><span className="dep-label">{wallet.delegate ? "Depositor / delegate address" : "Depositor address"}</span><Address value={wallet.delegate ?? wallet.holder} explorer={data.explorer} full /><small>The sender wallet that pays transaction fees</small></div><div><span className="dep-label">Gas balance</span><strong className={wallet.balance !== null && Number(wallet.balance) < 0.1 ? "dep-low" : ""}>{wallet.balance === null ? "—" : `${number(wallet.balance, 5)} ETH`}</strong><small>{wallet.balance !== null && Number(wallet.balance) < 0.1 ? "Low gas funding: below 0.1 ETH" : "Current wallet balance"}</small></div><div><span className="dep-label">{wallet.delegate ? "EDF delegation contract" : "TOP_UP_ROLE holder"}</span><Address value={wallet.holder} explorer={data.explorer} full /><small>{wallet.delegate ? `Contract balance: ${wallet.holderBalance === null ? "unknown" : number(wallet.holderBalance, 5) + " ETH"}` : "Direct role holder"}</small></div>{wallet.owner && <div><span className="dep-label">EDF owner</span><Address value={wallet.owner} explorer={data.explorer} full /><small>Controls delegation and key rotation</small></div>}<div className="dep-wallet-status"><span className={`dep-pill ${wallet.terminated === true ? "bad" : wallet.terminated === false ? "good" : "neutral"}`}>{wallet.terminated === true ? "EDF terminated" : wallet.terminated === false ? "EDF active" : "EDF state unknown"}</span><span className="dep-pill good">Holds TOP_UP_ROLE</span><a href={`${data.explorer}/address/${wallet.delegate ?? wallet.holder}`} target="_blank" rel="noreferrer">Full wallet history, including failed attempts <ExternalLink size={12} /></a></div></div>)}</section>
        <section className="panel dep-ledger"><header className="panel-header"><div><h2>Transaction ledger</h2><p>Confirmed deposit & top-up events since {date(data.activityFrom)} · through block {data.activityTo.toLocaleString("en-US")}{data.activityTruncated ? " · latest 120 operations" : ""}</p></div><span className="dep-count">{filtered.length} transactions</span></header><div className="dep-ledger-tools"><div className="dep-filter" role="group" aria-label="Transaction type">{[["all", "All activity"], ["deposit", "Deposits"], ["topup", "Top-ups"]].map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} className={kind === value ? "active" : ""} onClick={() => { setKind(value); setShown(20); }}>{label}</button>)}</div><input aria-label="Search transactions" placeholder="Search hash, sender, block or module…" value={search} onChange={(e) => { setSearch(e.target.value); setShown(20); }} /></div><div className="table-scroll"><table className="dep-transactions"><thead><tr><th>Transaction / UTC time</th><th>Operation</th><th>ETH moved</th><th>Sender</th><th>Gas cost</th><th>Block</th></tr></thead><tbody>{filtered.slice(0, shown).map((tx) => <tr key={tx.hash}><td><a className="dep-tx-link" href={`${data.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{short(tx.hash)}<ExternalLink size={12} /></a><small>{date(tx.timestamp)}</small></td><td><span className={`dep-kind ${tx.kind}`}>{tx.kind === "topup" ? "Top-up" : "Deposit"}</span>{tx.modules.length > 0 && <small>Module {tx.modules.join(", ")}</small>}</td><td className="dep-numeric">{tx.amount === null ? "Unavailable" : displayEth(tx.amount)}</td><td><Address value={tx.from} explorer={data.explorer} /></td><td className="dep-numeric">{number(tx.gasCost, 6)} ETH<small>{Number(tx.gasUsed).toLocaleString("en-US")} gas</small></td><td><a href={`${data.explorer}/block/${tx.block}`} target="_blank" rel="noreferrer">{tx.block.toLocaleString("en-US")}</a></td></tr>)}</tbody></table></div>{filtered.length === 0 && <div className="dep-empty">{search || kind !== "all" ? "No transactions match these filters." : "No confirmed deposit or top-up events were found in this window."}</div>}{filtered.length > shown && <button type="button" className="dep-more" onClick={() => setShown((value) => value + 20)}>Show 20 more ({filtered.length - shown} remaining)</button>}{data.activityTruncated && <div className="dep-ledger-note">Deposit and top-up totals cover the latest 120 operations.</div>}</section>
        <section className="panel"><header className="panel-header"><div><h2>Protocol contracts</h2><p>Resolved from the Lido Locator at the displayed block</p></div></header><div className="dep-contracts">{[["Lido Locator", data.addresses.locator], ["Lido / stETH", data.addresses.lido], ["Deposit Security Module", data.addresses.dsm], ["TopUpGateway", data.addresses.gateway], ["Staking Router", data.addresses.router], ["Withdrawal Queue", data.addresses.withdrawalQueue], ["Validator Exit Bus Oracle", data.addresses.vebo]].map(([label, value]) => <div key={label}><span className="dep-label">{label}</span>{value ? <Address value={value} explorer={data.explorer} full /> : <span>Unavailable</span>}</div>)}</div></section>
      </>}
      <footer className="dep-footer"><span>Lido Depositor Watch · Independent public-data monitor</span><span>ETH figures use contract accounting. Recent blocks may reorganize. All times UTC.</span></footer>
    </div>
  </main>;
}
