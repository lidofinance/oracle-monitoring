"use client";
import { DATA_REFRESH_INTERVAL_MS } from "../refresh-policy";
import { useLoadingTask } from "../loading-status";
import { rpcFetch } from "../rpc-client";

import SiteHeader, { NetworkBar } from "../site-header";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, CheckCircle2, Clock3, ExternalLink, RefreshCw, ShieldCheck, X } from "lucide-react";
import { COUNCIL_BUS, COUNCIL_CHAINS, COUNCIL_NETWORKS, councilNetwork, type CouncilNetwork, type CouncilActivity, type CouncilChain, type CouncilEvent, type CouncilGuardian, type CouncilSnapshot } from "../council-data";
import "./style.css";

const count = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 0 });
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const utc = (value: number) => new Date(value * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const age = (timestamp: number | null | undefined, now: number) => {
  if (timestamp === null || timestamp === undefined) return "Not observed";
  const seconds = Math.max(0, now - timestamp);
  return seconds < 60 ? "Just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
};
const balance = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return n > 0 && n < .0001 ? "<0.0001" : n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
};
const kindLabels = { deposit: "Deposit", ping: "Ping", pause: "Pause", unvet: "Unvet", resume: "Unpause" };
function LinkAddress({ value, chain = "ethereum", full = false }: { value: string; chain?: CouncilChain; full?: boolean }) {
  return <a className="cw-address" href={`${COUNCIL_CHAINS[chain].explorer}/address/${value}`} target="_blank" rel="noreferrer" title={value}>{full ? value : short(value)}<ArrowUpRight size={11} /></a>;
}
function TxLink({ event }: { event: CouncilEvent }) {
  return <a className="cw-address" href={`${COUNCIL_CHAINS[event.chain].explorer}/tx/${event.hash}`} target="_blank" rel="noreferrer">{short(event.hash)}<ExternalLink size={11} /></a>;
}
function GuardianRow({ guardian: g, activity, now, network }: { guardian: CouncilGuardian; activity: CouncilActivity | null; now: number; network: CouncilNetwork }) {
  const { balanceChains: chains, executionChain } = COUNCIL_NETWORKS[network];
  const record = activity?.members.find(m => m.guardian === g.address);
  const last = record?.lastCurrent;
  const recent = !!last && now - last.timestamp < 6 * 3600;
  return <article className="cw-guardian">
    <div className="cw-identity"><div className="cw-member-name"><span className={`cw-dot ${g.terminated || !g.wallet ? "bad" : recent ? "good" : "quiet"}`} /><h3>{g.name}</h3></div><div className="cw-key-label">Guardian <LinkAddress chain={executionChain} value={g.address} /></div><div className="cw-key-label">Delegate {g.wallet ? <LinkAddress chain={executionChain} value={g.wallet} /> : <span>Unavailable / revoked</span>}</div>
      <details><summary>Keys & contract</summary><div className="cw-key-details"><span>Guardian contract</span><LinkAddress chain={executionChain} value={g.address} full /><span>Active delegate</span>{g.wallet ? <LinkAddress chain={executionChain} value={g.wallet} full /> : "No active delegate"}<span>Owner</span>{g.owner ? <LinkAddress chain={executionChain} value={g.owner} full /> : "Unavailable"}<span>EDF state</span><strong>{g.terminated === null ? "Unavailable" : g.terminated ? "Terminated" : "Active"}</strong>{g.pendingDelegate && <><span>Pending delegate</span><LinkAddress chain={executionChain} value={g.pendingDelegate} full /><small>{g.pendingFrom ? `Eligible from ${utc(g.pendingFrom)}` : "Activation time unavailable"}</small></>}{g.legacy && <><span>Published pre-EDF wallet</span><LinkAddress chain={executionChain} value={g.legacy} full /></>}</div></details>
    </div>
    {chains.map(chain => <div className={`cw-wallet ${g.balances[chain] != null && Number(g.balances[chain]) === 0 ? "empty" : ""}`} key={chain}><span className="cw-mobile-label">{COUNCIL_CHAINS[chain].name}</span><strong title={g.balances[chain] ?? "Unavailable"}>{balance(g.balances[chain])} <small>{COUNCIL_CHAINS[chain].symbol}</small></strong>{g.wallet && <a href={`${COUNCIL_CHAINS[chain].explorer}/address/${g.wallet}`} target="_blank" rel="noreferrer">{g.balances[chain] == null ? "Read unavailable" : Number(g.balances[chain]) === 0 ? "No gas funds" : "Wallet history"}<ArrowUpRight size={10} /></a>}</div>)}
    <div className="cw-last"><span className={`cw-state ${recent ? "good" : "quiet"}`}>{activity ? recent ? "Recent broadcast" : last ? "No broadcast in 6h" : "Not observed in 7d" : "Loading activity…"}</span><strong>{age(last?.timestamp, now)}</strong>{last && <small>{COUNCIL_CHAINS[last.chain].name} · v{last.version ?? "unknown"}</small>}<small>{record ? `${count(record.deposits)} deposits · ${count(record.pings)} pings` : "—"}</small>{record?.last && !record.last.currentKey && <small className="cw-former">Latest observed message uses another known key</small>}</div>
  </article>;
}
function GuardianHistory({ data, names }: { data: CouncilActivity; names: Map<string, string> }) {
  const [selected, setSelected] = useState<{ guardian: string; day: number } | null>(null);
  const record = selected ? data.members.find(m => m.guardian === selected.guardian) : null;
  return <section className="panel cw-history"><header className="panel-header"><div><h2>Daily guardian activity</h2><p>Observed broadcasts per guardian · current Council, including known earlier keys</p></div><span className="cw-status-chip">Hover or tap a cell</span></header><div className="table-scroll"><div className="cw-heatmap"><div className="cw-heatmap-head"><span>Guardian</span>{data.daily.map(d => <span key={d.timestamp}>{new Date(d.timestamp * 1000).toISOString().slice(5,10)}</span>)}</div>{data.members.map(m => <div className="cw-heatmap-row" key={m.guardian}><strong>{names.get(m.guardian) ?? short(m.guardian)}</strong>{m.daily.map((amount,day) => <button type="button" key={day} style={{ background: amount ? `rgba(20,125,91,${.12 + .58 * amount / Math.max(...m.daily,1)})` : '#f1f3ee', color: amount / Math.max(...m.daily,1) > .6 ? '#fff' : '#28533d' }} onMouseEnter={() => setSelected({guardian:m.guardian,day})} onFocus={() => setSelected({guardian:m.guardian,day})} onClick={() => setSelected({guardian:m.guardian,day})} aria-label={`${names.get(m.guardian)}, ${new Date(data.daily[day].timestamp*1000).toISOString().slice(0,10)}: ${count(amount)} broadcasts, ${count(m.dailyPings[day])} pings`}>{count(amount)}</button>)}</div>)}</div></div><div className="cw-history-detail" aria-live="polite">{selected && record ? <>{names.get(record.guardian)} · {new Date(data.daily[selected.day].timestamp*1000).toISOString().slice(0,10)} UTC: <strong>{count(record.daily[selected.day])} broadcasts</strong>, including <strong>{count(record.dailyPings[selected.day])} pings</strong>.</> : 'Message counts measure observed onchain activity, not daemon uptime. Each row uses its own color scale.'}</div></section>;
}
function EventDetail({ event, onClose, names }: { event: CouncilEvent; onClose: () => void; names: Map<string, string> }) {
  useEffect(() => { const handle = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle); }, [onClose]);
  return <div className="cw-overlay" onClick={onClose}><section className="cw-dialog" role="dialog" aria-modal="true" aria-label="Council event details" onClick={e => e.stopPropagation()}><header><div><span className="cw-eyebrow">{event.stage === "message" ? "DataBus broadcast" : "DSM transaction"}</span><h2>{kindLabels[event.kind]} details</h2></div><button type="button" onClick={onClose} aria-label="Close event details" autoFocus><X size={19} /></button></header><dl><div><dt>Transaction</dt><dd><TxLink event={event} /></dd></div><div><dt>Network / time</dt><dd>{COUNCIL_CHAINS[event.chain].name} · {utc(event.timestamp)}</dd></div><div><dt>Sender</dt><dd><LinkAddress value={event.sender} chain={event.chain} full /></dd></div><div><dt>Guardian attribution</dt><dd>{event.guardians.map(a => names.get(a) ?? short(a)).join(", ") || "No individual guardian identified"}</dd></div><div><dt>Result</dt><dd>{event.success ? event.stage === "message" ? "Message included onchain; signature validity is not assessed here" : "Confirmed successful call" : "Reverted transaction"}</dd></div></dl><pre>{JSON.stringify(event.payload, null, 2)}</pre></section></div>;
}

export default function CouncilMonitor() {
  const [network, setNetwork] = useState<CouncilNetwork>("mainnet");
  const [ready, setReady] = useState(false);
  const config = COUNCIL_NETWORKS[network], chains = config.balanceChains, executionChain = config.executionChain;
  const [state, setState] = useState<CouncilSnapshot | null>(null);
  const [activity, setActivity] = useState<CouncilActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [kind, setKind] = useState("all"), [source, setSource] = useState("all"), [guardian, setGuardian] = useState("all"), [search, setSearch] = useState("");
  const [shown, setShown] = useState(25), [selected, setSelected] = useState<CouncilEvent | null>(null);
  const [now, setNow] = useState(0);
  useLoadingTask(network,"Council membership and balances",loading,!!error||!!state?.warnings.length);
  useLoadingTask(network,"Council messages and DSM activity",activityLoading,!!activityError||!!activity?.warnings.length);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort(); const active = new AbortController(); controller.current = active;
    setLoading(true); setActivityLoading(true);
    const read = async <T,>(section: string): Promise<T> => {
      const response = await rpcFetch(`/api/council?network=${network}${section ? "&section=activity" : ""}`, { signal: active.signal });
      const data = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(data.error ?? "Council data unavailable");
      if ((data as T & { network: string }).network !== network) throw new Error("Council response network mismatch"); return data;
    };
    await Promise.all([
      read<CouncilSnapshot>("").then(data => { if (!active.signal.aborted) { setState(data); setError(null); setNow(Math.floor(Date.now() / 1000)); } }).catch(e => { if (!active.signal.aborted) setError(e.message); }).finally(() => { if (!active.signal.aborted) setLoading(false); }),
      read<CouncilActivity>("activity").then(data => { if (!active.signal.aborted) { setActivity(data); setActivityError(null); } }).catch(e => { if (!active.signal.aborted) setActivityError(e.message); }).finally(() => { if (!active.signal.aborted) setActivityLoading(false); }),
    ]);
  }, [network]);
  const switchNetwork = useCallback((next: CouncilNetwork, updateUrl = true) => {
    if (next === network) return;
    controller.current?.abort();
    setNetwork(next); setState(null); setActivity(null); setError(null); setActivityError(null);
    setLoading(true); setActivityLoading(true); setSelected(null); setKind("all"); setSource("all"); setGuardian("all"); setSearch(""); setShown(25);
    if (updateUrl) { const url = new URL(window.location.href); url.searchParams.set("network", next); window.history.pushState({}, "", url); }
  }, [network]);
  useEffect(() => {
    const readUrl = () => switchNetwork(councilNetwork(new URLSearchParams(window.location.search).get("network")) ?? "mainnet", false);
    const initial = setTimeout(() => { readUrl(); setReady(true); }, 0);
    window.addEventListener("popstate", readUrl);
    return () => { clearTimeout(initial); window.removeEventListener("popstate", readUrl); };
  }, [switchNetwork]);
  useEffect(() => {
    if (!ready) return;
    const initial = setTimeout(() => void load(), 0);
    const refresh = setInterval(() => { if (!document.hidden) void load(); }, DATA_REFRESH_INTERVAL_MS);
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => { clearTimeout(initial); clearInterval(refresh); clearInterval(clock); controller.current?.abort(); };
  }, [load, ready]);
  const members = state?.guardians ?? [];
  const names = new Map(members.map(g => [g.address, g.name]));
  const observed = activity?.members.filter(m => m.lastCurrent && now - m.lastCurrent.timestamp < 6 * 3600).length;
  const filtered = (activity?.events ?? []).filter(e => (kind === "all" || kind === e.kind) && (source === "all" || source === e.stage || source === e.chain) && (guardian === "all" || e.guardians.includes(guardian)) && `${e.hash} ${e.sender} ${e.moduleId ?? ""} ${e.guardians.map(a => names.get(a) ?? a).join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const resetFilter = (setter: (value: string) => void, value: string) => { setter(value); setShown(25); };
  return <main className={`app-shell cw-shell cw-${network}`}>
    <SiteHeader network={network} title="Lido Council Watch" subtitle="Deposit security · Onchain monitor" icon={<ShieldCheck size={18}/>} actions={<><span className="updated">{state ? `Updated ${utc(state.updatedAt).slice(11)}` : "Reading contracts…"}</span><button className="refresh-button" type="button" onClick={() => void load()} disabled={!ready || loading || activityLoading}><RefreshCw size={14} className={loading || activityLoading ? "spin" : ""} /> Refresh</button></>}/>
    <NetworkBar network={network} onChange={switchNetwork} label="Council network" idPrefix="council-tab" panelId="council-panel"/>
    <div className="workspace cw-workspace" id="council-panel" role="tabpanel" aria-labelledby={`council-tab-${network}`}><div className="cw-heading"><div className="cw-eyebrow">LIDO / DEPOSIT SECURITY COMMITTEE</div><h1>The guardians behind each deposit.</h1><p>Follow Council delegate funding, deposit attestations and the messages that protect the protocol.</p></div>
      {error && <div className="report-warning" role="alert">{error} {state && "Showing the last successful snapshot."}</div>}
      {state?.warnings.map(w => <div className="report-warning" role="status" key={w}>{w}</div>)}
      {activityError && <div className="report-warning" role="alert">{activityError} {activity && "Showing the last successful activity window."}</div>}{activity?.warnings.map(w => <div className="report-warning" role="status" key={w}>{w}</div>)}
      <div className="cw-overview" aria-label="DSM state and activity">
        <article className={`cw-metric cw-security ${state?.paused ? "paused" : ""}`}><span>Deposit Security Module</span><strong>{state ? state.paused ? "Paused" : "Unpaused" : "—"}</strong><p>{state ? `${state.quorum} of ${members.length} guardian signatures required` : "Reading live Council membership"}</p>{state && <LinkAddress chain={executionChain} value={state.dsm} />}</article>
        <section id="dsm-activity" className="panel cw-dsm"><header className="panel-header"><div><h2>DSM activity</h2><p>{COUNCIL_CHAINS[executionChain].name} transactions · seven UTC calendar days</p></div><ShieldCheck size={18} /></header><div className="cw-action-stats">{([['pauses','Pause calls'],['unvets','Unvet calls'],['depositsExecuted','Deposit calls']] as const).map(([key,label]) => <div key={key}><span>{label}</span><strong>{activity ? `${activity.dsmHistoryComplete ? "" : "≥"}${count(activity.totals[key])}` : "—"}</strong></div>)}</div><div className="cw-dsm-details"><div><span>Last DSM deposit</span><strong>{age(state?.lastDeposit?.timestamp, now)}</strong>{state?.lastDeposit && <a href={`${COUNCIL_CHAINS[executionChain].explorer}/block/${state.lastDeposit.block}`} target="_blank" rel="noreferrer">{utc(state.lastDeposit.timestamp)} <ExternalLink size={10} /></a>}</div><div><span>Pause intent validity</span><strong>{state?.pauseValidityBlocks === null || !state ? "—" : `${count(state.pauseValidityBlocks)} ${COUNCIL_CHAINS[executionChain].name} blocks`}</strong></div><div><span>Maximum operators per unvet</span><strong>{state?.maxOperatorsPerUnvet === null || !state ? "—" : count(state.maxOperatorsPerUnvet)}</strong></div></div></section>
      </div>
      <section id="guardians" className="panel cw-guardians"><header className="panel-header"><div><h2>Council daemons</h2><p>Current DSM guardians and their active delegate wallets</p></div><span className="cw-status-chip"><i className="cw-dot good" />{activity ? `${observed} / ${members.length} recent broadcasters` : "Reading message activity…"}</span></header><div className="cw-table-heading"><span>Guardian & delegate</span>{chains.map(chain => <span key={chain}>{COUNCIL_CHAINS[chain].name} / {COUNCIL_CHAINS[chain].symbol}</span>)}<span>Current key activity</span></div>{members.map(g => <GuardianRow key={g.address} guardian={g} activity={activity} now={now} network={network} />)}{!state && <div className="cw-empty" role="status">{loading ? "Reading Council membership and wallet balances…" : "Retrying Council membership automatically."}</div>}<div className="cw-note"><Clock3 size={13} /><p>Recent means a broadcast from the current delegate in the last six hours. A quiet DataBus does not prove a daemon is down. Native-token balances are shown separately for each network.</p></div></section>
      {activity && <GuardianHistory key={network} data={activity} names={names} />}
      <section id="activity" className="panel cw-ledger"><header className="panel-header"><div><h2>Messages & DSM transactions</h2><p>{activity ? `${utc(activity.from).slice(0, 10)} – ${utc(activity.to)} · ${activity.events.length} of ${count(activity.total)} records retained` : "Confirmed Council activity with explorer links"}</p></div><span className="cw-status-chip">{activityLoading ? "Refreshing…" : `${count(filtered.length)} matching`}</span></header><div className="cw-filters"><label>Operation<select aria-label="Operation" value={kind} onChange={e => resetFilter(setKind,e.target.value)}><option value="all">All operations</option>{Object.entries(kindLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Source<select aria-label="Source" value={source} onChange={e => resetFilter(setSource,e.target.value)}><option value="all">All sources</option><option value="message">DataBus messages</option><option value="execution">DSM transactions</option>{config.busChains.map(chain => <option key={chain} value={chain}>{COUNCIL_CHAINS[chain].name}</option>)}</select></label><label>Guardian<select aria-label="Guardian" value={guardian} onChange={e => resetFilter(setGuardian,e.target.value)}><option value="all">All guardians</option>{members.map(g => <option key={g.address} value={g.address}>{g.name}</option>)}</select></label><label className="cw-search">Search<input aria-label="Search Council transactions" value={search} onChange={e => resetFilter(setSearch,e.target.value)} placeholder="Transaction, wallet, module or operator…" /></label></div><div className="table-scroll"><table className="cw-transactions"><thead><tr><th>Time / transaction</th><th>Operation</th><th>Network / source</th><th>Guardian / sender</th><th>Reference</th><th /></tr></thead><tbody>{filtered.slice(0,shown).map(e => <tr key={e.id}><td><span>{utc(e.timestamp)}</span><TxLink event={e} /></td><td><span className={`cw-kind ${e.kind}`}>{kindLabels[e.kind]}</span><small>{!e.success ? "Reverted" : e.stage === "message" ? "Broadcast" : "Confirmed call"}</small></td><td>{COUNCIL_CHAINS[e.chain].name}<small>{e.stage === "message" ? "DataBus" : "DSM"}</small></td><td><strong>{e.guardian ? names.get(e.guardian) ?? short(e.guardian) : e.guardians.length ? `${e.guardians.length} guardian signatures` : "Protocol transaction"}</strong><LinkAddress value={e.sender} chain={e.chain} />{e.stage === "message" && !e.currentKey && <small>Other known key</small>}</td><td>{e.moduleId === null ? "—" : `Module ${e.moduleId}`}<small>{e.referenceBlock ? `${COUNCIL_CHAINS[executionChain].name} block ${count(e.referenceBlock)}` : ""}{e.version ? ` · v${e.version}` : ""}</small></td><td><button type="button" onClick={() => setSelected(e)} aria-label={`Details for ${e.kind} transaction ${e.hash}`}>Details <ArrowUpRight size={12} /></button></td></tr>)}</tbody></table></div>{filtered.length === 0 && <div className="cw-empty">{activityLoading ? "Reading onchain history…" : "No loaded records match these filters."}</div>}{filtered.length>shown && <button className="cw-more" type="button" onClick={() => setShown(n=>n+25)}>Show 25 more ({filtered.length-shown} remaining)</button>}<div className="cw-note"><CheckCircle2 size={13} /><p>Charts and totals use the full loaded window; the ledger retains up to 500 broadcasts and 100 DSM calls. Attribution uses current delegates, known rotation history and published pre-EDF wallets. Inclusion onchain is not a verification of the payload’s signature.</p></div></section>
      <section className="panel cw-sources"><header className="panel-header"><div><h2>Contracts & data coverage</h2><p>Membership resolves from Lido Locator; balances use a confirmed block on each network</p></div></header><div className="cw-source-grid"><div><span>Lido Locator</span><LinkAddress chain={executionChain} value={config.locator} /></div><div><span>Deposit Security Module</span>{state ? <LinkAddress chain={executionChain} value={state.dsm} /> : "—"}</div>{config.busChains.map(chain => <div key={chain}><span>{COUNCIL_CHAINS[chain].name} DataBus</span><LinkAddress value={COUNCIL_BUS} chain={chain} /><small>{activity ? activity.coverage[chain] ? "Full requested log range loaded" : "Partial / unavailable log range" : "Loading coverage…"}</small></div>)}<div><span>DSM transaction index</span><a href={state ? `${config.indexer}/address/${state.dsm}` : config.indexer} target="_blank" rel="noreferrer">Blockscout · verified against RPC receipts <ExternalLink size={11} /></a><small>{activity ? activity.dsmHistoryComplete ? "Requested history loaded" : "Some history is incomplete" : "Loading coverage…"}</small></div><div><span>Protocol references</span><a href="https://docs.lido.fi/contracts/deposit-security-module/" target="_blank" rel="noreferrer">DSM documentation <ExternalLink size={11} /></a><a href={config.reference} target="_blank" rel="noreferrer">Council deployment reference <ExternalLink size={11} /></a></div></div></section>
      <footer className="cw-footer">Lido Council Watch · Independent public-data monitor. All times UTC. No access to daemon hosts or private metrics.</footer>
    </div>{selected && <EventDetail event={selected} names={names} onClose={() => setSelected(null)} />}
  </main>;
}
