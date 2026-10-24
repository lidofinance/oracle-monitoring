import { DATA_REFRESH_INTERVAL_MS } from "./refresh-policy.ts";
export function recoveryDelay(attempt:number){return Math.min(8 * DATA_REFRESH_INTERVAL_MS,DATA_REFRESH_INTERVAL_MS*2**Math.min(Math.max(0,attempt),3));}
export function retryableStatus(status:number){return [408,425,429,500,502,503,504].includes(status);}
export function waitForRetry(ms:number,signal?:AbortSignal|null):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason??new DOMException('Aborted','AbortError'));return;}
    const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(signal?.reason??new DOMException('Aborted','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
    signal?.addEventListener('abort',stop,{once:true});
  });
}
export function requestRetryDelay(attempt:number,retryAfter:string|null,now=Date.now(),random=Math.random()){
  const backoff=Math.min(8_000,1000*2**attempt)+Math.floor(Math.max(0,Math.min(1,random))*250);
  if(!retryAfter)return backoff;
  const seconds=Number(retryAfter),requested=Number.isFinite(seconds)?seconds*1000:Date.parse(retryAfter)-now;
  return Number.isFinite(requested)?Math.max(backoff,requested):backoff;
}
/** Only GET/HEAD reads are replayed. Explicit cancellation always wins over a retry. */
export async function fetchWithRetry(input:string,init:RequestInit={},options:{fetcher?:typeof fetch;sleep?:typeof waitForRetry;attempts?:number;timeoutMs?:number;random?:()=>number}={}){
  const fetcher=options.fetcher??fetch,sleep=options.sleep??waitForRetry;
  const read=['GET','HEAD'].includes((init.method??'GET').toUpperCase()),attempts=read?options.attempts??4:1;
  if(!Number.isSafeInteger(attempts)||attempts<1||attempts>8)throw Error('Invalid retry count');
  for(let attempt=0;attempt<attempts;attempt++){
    init.signal?.throwIfAborted();
    let response:Response;
    try{
      const timeout=AbortSignal.timeout(options.timeoutMs??90_000);
      response=await fetcher(input,{...init,signal:init.signal?AbortSignal.any([init.signal,timeout]):timeout});
    }catch(error){
      init.signal?.throwIfAborted();
      if(attempt===attempts-1)throw error;
      await sleep(requestRetryDelay(attempt,null,Date.now(),options.random?.()),init.signal);
      continue;
    }
    if(!retryableStatus(response.status)||attempt===attempts-1)return response;
    const delay=requestRetryDelay(attempt,response.headers.get('retry-after'),Date.now(),options.random?.());
    await response.body?.cancel().catch(()=>{});
    await sleep(delay,init.signal);
  }
  throw Error('Request retries exhausted');
}
