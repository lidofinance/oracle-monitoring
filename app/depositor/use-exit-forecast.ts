"use client";
import { DATA_REFRESH_INTERVAL_MS } from "../refresh-policy";
import { useLoadingTask } from "../loading-status";
import { rpcFetch } from "../rpc-client";
import { useEffect, useState } from "react";
import type { ExitWithdrawalForecast } from "../exit-withdrawal-forecast-data";

export function useExitForecast(network:"mainnet"|"hoodi",refreshKey:number){
  const [result,setResult]=useState<ExitWithdrawalForecast|null>(null),[failed,setFailed]=useState(false),[now,setNow]=useState(0),[fetching,setFetching]=useState(true);
  const current=result?.network===network?result:null;
  useLoadingTask(network,"Withdrawal timing and Lido inflow",fetching||(!failed&&(!current||current.status==='loading')),failed||current?.timingStatus==='unavailable'||current?.inflowStatus==='unavailable');
  useEffect(()=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
    const load=async()=>{
      let delay=DATA_REFRESH_INTERVAL_MS;setFetching(true);
      setNow(Math.floor(Date.now()/1000));
      try{
        const response=await rpcFetch(`/api/depositor?network=${network}&view=exit-forecast`,{cache:'no-store',signal:controller.signal});
        const body=await response.json() as ExitWithdrawalForecast;
        if(!response.ok||body.network!==network||!['loading','ready'].includes(body.status))throw Error('Invalid withdrawal forecast');
        if(!stopped){setResult(body);setFailed(false);}if(body.status==='loading')delay=3000;else if(body.timingStatus==='unavailable'||body.inflowStatus==='unavailable')delay=DATA_REFRESH_INTERVAL_MS;
      }catch{if(!stopped)setFailed(true);delay=DATA_REFRESH_INTERVAL_MS;}
      if(!stopped)setFetching(false);
      if(!stopped)timer=setTimeout(()=>{if(!document.hidden)void load();else timer=setTimeout(()=>void load(),DATA_REFRESH_INTERVAL_MS);},delay);
    };
    void load();return()=>{stopped=true;controller.abort();clearTimeout(timer);};
  },[network,refreshKey]);
  return {result:result?.network===network?result:null,failed,now};
}
