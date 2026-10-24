"use client";
import { useEffect,useId,useSyncExternalStore } from "react";
import { CircleCheck,LoaderCircle,TriangleAlert } from "lucide-react";
import { createLoadingRegistry,type LoadingNetwork } from "./loading-state";
const registry=createLoadingRegistry();
export function useLoadingTask(network:LoadingNetwork,label:string,loading:boolean,failed=false){
  const id=useId();
  useEffect(()=>{registry.update(id,network,label,loading?'loading':failed?'error':'ready');},[id,network,label,loading,failed]);
  useEffect(()=>()=>registry.remove(id),[id,network]);
}
export default function LoadingStatus({network,home=false}:{network:LoadingNetwork;home?:boolean}){
  const state=useSyncExternalStore(registry.subscribe,()=>registry.snapshot(network),registry.serverSnapshot);
  const pending=state.pending>0||(!home&&state.total===0),failed=state.errors>0;
  const text=pending?'Loading data…':failed?'Partial data':'Loaded';
  const detail=pending?`Loading: ${state.pendingLabels.join(', ')||'page data'}`:failed?`Loading finished. Unavailable: ${state.errorLabels.join(', ')}`:'No data requests or background calculations are pending.';
  return <span className={`site-loading-status ${pending?'pending':failed?'partial':'ready'}`} role="status" aria-live="polite" aria-atomic="true" aria-label={`Data loading status: ${text}`} aria-busy={pending} title={detail}>
    {pending?<LoaderCircle size={14} className="spin" aria-hidden="true"/>:failed?<TriangleAlert size={14} aria-hidden="true"/>:<CircleCheck size={14} aria-hidden="true"/>}<span>{text}</span>
  </span>;
}
