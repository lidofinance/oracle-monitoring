"use client";
import { useSyncExternalStore } from "react";
import { fetchWithRetry } from "./request-retry";
import { RPC_OPTIONS, RPC_STORAGE_KEY, parseRpcChoice, type RpcChoice, type RpcNetwork } from "./rpc-selection";
const listeners = new Set<() => void>();
let memoryChoice: string | undefined;
export function readRpcChoiceRaw() {
  try { return window.localStorage.getItem(RPC_STORAGE_KEY) ?? ""; } catch {
    if(memoryChoice)return memoryChoice;
    const params=new URLSearchParams(window.location.search),choice:RpcChoice={};
    for(const network of ["mainnet","hoodi"] as const){const preset=RPC_OPTIONS[network].find(option=>option.id===params.get(`${network}Rpc`));if(preset)choice[network]=preset.url;}
    return JSON.stringify(choice);
  }
}
export function subscribeRpcChoice(listener: () => void) {
  listeners.add(listener); window.addEventListener("storage", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
}
export function useRpcChoice() {
  return parseRpcChoice(useSyncExternalStore(subscribeRpcChoice, readRpcChoiceRaw, () => ""));
}
export function rpcFetch(input: string, init: RequestInit = {}) {
  const url = new URL(input, window.location.href), network = url.searchParams.get("network");
  const headers = new Headers(init.headers);
  if (url.origin === window.location.origin && (network === "mainnet" || network === "hoodi")) {
    const chosen = parseRpcChoice(readRpcChoiceRaw())[network];
    const preset = RPC_OPTIONS[network].find(option => option.url === chosen);
    if (preset) headers.set("x-lido-rpc", preset.id);
  }
  return fetchWithRetry(input, { ...init, headers, cache: "no-store" });
}
export default function RpcPicker({ network }: { network: RpcNetwork }) {
  const choice = useRpcChoice(), chosen = choice[network] ?? "";
  function change(url: string) {
    const next: RpcChoice = { ...choice, [network]: url || undefined };
    memoryChoice = JSON.stringify(next);
    try { window.localStorage.setItem(RPC_STORAGE_KEY, memoryChoice); } catch {
      const page=new URL(window.location.href);
      for(const n of ["mainnet","hoodi"] as const){const preset=RPC_OPTIONS[n].find(option=>option.url===next[n]);if(preset)page.searchParams.set(`${n}Rpc`,preset.id);else page.searchParams.delete(`${n}Rpc`);}
      window.history.replaceState(null,"",page);
    }
    listeners.forEach(listener => listener());
    // Recreate every independent collector together; aborts and old UI state
    // cannot mix data from different providers after a source change.
    window.location.reload();
  }
  return <label className="site-rpc-picker" title={`Ethereum execution RPC · ${network === "mainnet" ? "Mainnet" : "Hoodi"}`}>
    <span>RPC</span>
    <select aria-label={`${network === "mainnet" ? "Mainnet" : "Hoodi"} RPC endpoint`} value={chosen} onChange={event => change(event.target.value)}>
      <option value="">Auto</option>
      {RPC_OPTIONS[network].map(option => <option key={option.id} value={option.url}>{option.label}</option>)}
    </select>
  </label>;
}
