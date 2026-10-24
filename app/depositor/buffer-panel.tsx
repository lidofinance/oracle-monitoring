"use client";
import { useId, useState } from "react";
import { useLidoExits } from "./use-lido-exits";
import type { LidoExitBalancePoint } from "../lido-exit-balances-data";
import type { DepositorSnapshot } from "../depositor-data";
const number=(value:string|number,digits=2)=>Number(value).toLocaleString("en-US",{maximumFractionDigits:digits,minimumFractionDigits:digits});
const date=(timestamp:number)=>new Date(timestamp*1000).toISOString().replace("T"," ").slice(0,19)+" UTC";
function BufferChart({ points: history, exits }: { points: DepositorSnapshot["history"]; exits: LidoExitBalancePoint[] }) {
  const exitDays = new Map(exits.map(point => [Math.floor(point.timestamp / 86400), point]));
  const points = history.map(point => {
    const exit = exitDays.get(Math.floor(point.timestamp / 86400));
    return { ...point, lidoExiting: exit?.balance ?? null, exitingValidators: exit?.validators ?? null, exitBeaconTimestamp: exit?.beaconTimestamp ?? null };
  });
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const tooltipId = useId();
  if (!points.some((point) => point.buffer !== null)) return <div className="dep-empty">Historical state is currently unavailable.</div>;
  const width = 740, height = 200, left = 64, right = 16, bottom = 25, top = 12;
  const max = Math.max(...points.flatMap((point) => [Number(point.buffer), Number(point.depositable), Number(point.withdrawalDemand ?? 0), Number(point.lidoExiting ?? 0)]), 1) * 1.08;
  const day = (timestamp: number) => Math.floor(timestamp / 86400) * 86400;
  const start = day(points[0].timestamp), end = day(points[points.length - 1].timestamp);
  const x = (timestamp: number) => left + (day(timestamp) - start) / Math.max(1, end - start) * (width - left - right);
  const y = (value: string | number) => height - bottom - Number(value) / max * (height - bottom - top);
  const path = (key: "buffer" | "depositable" | "withdrawalDemand" | "lidoExiting", fill = false) => {
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
      aria-label="Daily buffer ETH, depositable ETH, withdrawal demand and Lido exiting or awaiting-withdrawal balances, excluding consolidations, over seven UTC days. Hover, tap or use the arrow keys to inspect amounts rounded to whole ETH or stETH."
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
    <path d={path("lidoExiting")} fill="none" stroke="#4f829c" strokeWidth="2.5" />
    {points.map((point) => <g key={point.timestamp}>
      {point.buffer !== null && <circle cx={x(point.timestamp)} cy={y(point.buffer)} r="3" fill="#9ba9a0" />}
      {point.depositable !== null && <circle cx={x(point.timestamp)} cy={y(point.depositable)} r="3" fill="#147d5b" />}
      {point.withdrawalDemand !== null && <circle cx={x(point.timestamp)} cy={y(point.withdrawalDemand)} r="3" fill="#c47732" />}
      {point.lidoExiting !== null && <circle cx={x(point.timestamp)} cy={y(point.lidoExiting)} r="3" fill="#4f829c" />}
    </g>)}
    {points.map((point, i) => <text key={point.timestamp} x={x(point.timestamp)} y={height - 5} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>{new Date(point.timestamp * 1000).toISOString().slice(5, 10)}</text>)}
    {selected && <g className="dep-chart-selection" pointerEvents="none">
      <line x1={x(selected.timestamp)} x2={x(selected.timestamp)} y1={top} y2={height - bottom} stroke="#69756f" strokeDasharray="3 3" />
      {(["buffer", "depositable", "withdrawalDemand", "lidoExiting"] as const).map((key) => selected[key] === null ? null : <circle key={key} cx={x(selected.timestamp)} cy={y(selected[key])} r="4" fill={key === "buffer" ? "#9ba9a0" : key === "depositable" ? "#147d5b" : key === "lidoExiting" ? "#4f829c" : "#c47732"} stroke="white" strokeWidth="1.5" />)}
    </g>}
    </svg>
    {selected && <div id={tooltipId} className="dep-chart-tooltip" role="tooltip" style={{ left: `clamp(8px, calc(${x(selected.timestamp) / width * 100}% - 170px), calc(100% - 348px))` }}>
      <time dateTime={new Date(selected.timestamp * 1000).toISOString()}>{new Date(selected.timestamp * 1000).toISOString().slice(0, 10)} · {day(selected.timestamp) === end ? "Latest" : "Day close"} (UTC)</time>
      {([
        ["buffer", "Buffer", "ETH"],
        ["depositable", "Depositable", "ETH"],
        ["withdrawalDemand", "Withdrawal demand", "stETH"],
        ["lidoExiting", "Lido exiting + awaiting", "ETH"],
      ] as const).map(([key, label, unit]) => <div className="dep-tooltip-row" key={key}>
        <span><i className={key} />{label}</span>
        <strong>{selected[key] === null ? "Unavailable" : <>{number(selected[key], 0)} <small>{unit}</small></>}</strong>
      </div>)}
      {selected.lidoExiting !== null && selected.exitBeaconTimestamp !== null && <p className="dep-exit-tooltip-note">{number(selected.exitingValidators!, 0)} validators · Beacon {date(selected.exitBeaconTimestamp)} · excludes consolidations</p>}
    </div>}
  </div>;
}

export default function BufferPanel({data,network,refreshKey}:{data:DepositorSnapshot;network:"mainnet"|"hoodi";refreshKey:number}){
 const lidoExits=useLidoExits(network,refreshKey);
 const buffer=Number(data.amounts.buffer),available=Number(data.amounts.depositable);
 return <section id="buffer-history" className="panel"><header className="panel-header"><div><h2>Buffer over time</h2><p>Daily closes · seven UTC days · today latest · ETH / stETH</p></div><div className="dep-legend"><span><i className="buffer" />Buffer</span><span><i />Depositable</span><span><i className="withdrawal" />Withdrawal demand (stETH)</span><span><i className="lidoExiting" />Lido exiting + awaiting (ETH)</span></div></header><div className="dep-chart-wrap"><BufferChart points={data.history} exits={lidoExits?.data?.points ?? []} /></div><p className="dep-exit-balance-note">Lido line: actual balances of exiting validators and validators awaiting withdrawal; excludes consolidation sources. {lidoExits?.failed ? "Refresh failed; unavailable points are left as gaps. " : !lidoExits?.data || lidoExits.data.status==='loading' ? `Loading daily Beacon snapshots (${lidoExits?.data?.points.filter(p=>p.status!=='loading').length??0}/7)… ` : lidoExits.data.points.some(p=>p.status!=='ready') ? "Some historical states are unavailable; those points are left as gaps. " : ""}<a href={network==='mainnet'?'https://keys-api.lido.fi/':'https://keys-api-hoodi.testnet.fi/'} target="_blank" rel="noreferrer">KAPI</a> · <a href="https://ethereum.github.io/beacon-APIs/" target="_blank" rel="noreferrer">Beacon data</a></p><div className="dep-buffer-split"><div><span>Depositable share of buffer</span><strong>{buffer > 0 ? `${number(available / buffer * 100, 1)}%` : "—"}</strong></div><div className="dep-progress"><i style={{ width: `${buffer > 0 ? Math.min(100, available / buffer * 100) : 0}%` }} /></div><small>{number(Math.max(0, buffer - available))} ETH in the buffer is unavailable for deposits under the current contract rules.</small></div></section>;
}
