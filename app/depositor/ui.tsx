"use client";
import { useState } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
const short=(address:string)=>`${address.slice(0,8)}…${address.slice(-6)}`;
export function Address({ value, explorer, full = false }: { value: string; explorer: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  return <span className="dep-address"><a href={`${explorer}/address/${value}`} target="_blank" rel="noreferrer" title={value}>{full ? value : short(value)}<ArrowUpRight size={12} /></a><button type="button" aria-label={`Copy ${value}`} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  }}>{copied ? <Check size={12} /> : <Copy size={12} />}</button></span>;
}
export function Gate({ label, good }: { label: string; good: boolean | null }) {
  return <span className={`dep-gate ${good === null ? "unknown" : good ? "good" : "bad"}`}><i />{label}<strong>{good === null ? "Unknown" : good ? "Yes" : "No"}</strong></span>;
}
