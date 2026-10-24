"use client";
import { useEffect,useRef } from "react";
import { recoveryDelay } from "./request-retry";
/** A page-level recovery loop for exhausted requests or partial snapshots. */
export function useAutoRetry(failed:boolean,busy:boolean,retry:()=>void,key:string){
  const callback=useRef(retry),attempt=useRef(0);
  useEffect(()=>{callback.current=retry;},[retry]);
  useEffect(()=>{attempt.current=0;},[key]);
  useEffect(()=>{
    if(!failed&&!busy)attempt.current=0;
    if(!failed||busy)return;
    let stopped=false,timer:ReturnType<typeof setTimeout>;
    const run=()=>{
      if(stopped)return;
      if(document.hidden){timer=setTimeout(run,15_000);return;}
      attempt.current++;callback.current();
    };
    timer=setTimeout(run,recoveryDelay(attempt.current));
    return()=>{stopped=true;clearTimeout(timer);};
  },[failed,busy,key]);
}
