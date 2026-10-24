import { rpcCacheKey } from "../../rpc-server";
import { withRpcSelection } from "../../rpc-server";
import { NextRequest, NextResponse } from "next/server";
import { buildConsolidationSnapshot, executionDetails, recentBotAttempts } from "../../consolidation-source";
import type { ConsolidationNetwork, ConsolidationSnapshot } from "../../consolidation-data";

type Job={started:number;finished?:number;progress:string;data?:ConsolidationSnapshot;error?:string};
const jobs=new Map<string,Job>();
const attempts=new Map<string,{block:number;started:number;data?:Awaited<ReturnType<typeof recentBotAttempts>>;error?:string}>();
const response=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
async function handleGet(request:NextRequest){
  const n=request.nextUrl.searchParams.get('network')??'mainnet';
  if(n!=='mainnet'&&n!=='hoodi')return response({error:'Unknown consolidation network'},400);
  const network:ConsolidationNetwork=n,view=request.nextUrl.searchParams.get('view')??'summary';
  if(!['summary','transactions','attempts'].includes(view))return response({error:'Unknown consolidation view'},400);
  const page=Number(request.nextUrl.searchParams.get('page')??0);
  if(view==='transactions'&&(!Number.isSafeInteger(page)||page<0||page>10000))return response({error:'Invalid page'},400);
  let job=jobs.get(rpcCacheKey(network));
  if(view!=='summary'){
    if(!job?.data)return response({status:'loading',progress:job?.progress??'Load the consolidation summary first'},202);
    if(view==='transactions'){
      const ledger=job.data.executions,slice=ledger.slice(page*25,(page+1)*25);
      try{return response({status:'ready',page,total:ledger.length,transactions:await executionDetails(network,slice.map(t=>t.hash))});}
      catch{return response({status:'error',error:'Transaction details are temporarily unavailable. Execution events remain visible.'},503);}
    }
    if(network==='hoodi')return response({status:'unavailable',error:'No published Hoodi bot signer is configured. Successful executor transactions are listed from on-chain events.'});
    let feed=attempts.get(rpcCacheKey(network));
    if(!feed||Date.now()-feed.started>(feed.error?15000:300000)){
      feed={block:job.data.block,started:Date.now()};attempts.set(rpcCacheKey(network),feed);const active=feed;
      void recentBotAttempts(network,feed.block).then(data=>{active.data=data;}).catch(()=>{active.error='The bot transaction index is unavailable. Successful executions are still indexed directly from chain events.';});
    }
    return response(feed.data?{status:'ready',...feed.data,block:feed.block}:feed.error?{status:'error',error:feed.error}:{status:'loading',progress:'Loading bot attempts from the last 30 days'},feed.error?503:feed.data?200:202);
  }
  if(!job||(job.finished&&Date.now()-job.finished>(job.error?15000:120000))){
    const previous=job?.data;job={started:Date.now(),progress:'Starting finalized snapshot',data:previous};jobs.set(rpcCacheKey(network),job);const active=job;
    // Runs in the persistent Node service; independent of browser navigation.
    void buildConsolidationSnapshot(network,message=>{active.progress=message;}).then(data=>{active.data=data;active.finished=Date.now();}).catch(error=>{console.error('Consolidation collection:',String(error).replace(/https?:\/\/[^\s]+/g,'[RPC]'));active.error='Could not reconcile a complete consolidation snapshot. Please retry shortly.';active.finished=Date.now();});
  }
  return response(job.data?{status:'ready',...job.data,refreshing:!job.finished,refreshError:job.error}:job.error?{status:'error',error:job.error}:{status:'loading',progress:job.progress,started:job.started},job.data?200:job.error?503:202);
}

export async function GET(request: NextRequest) { return withRpcSelection(request, handleGet); }
