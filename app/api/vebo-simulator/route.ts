import { rpcCacheKey } from "../../rpc-server";
import { withRpcSelection } from "../../rpc-server";
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildVeboSnapshot, type VeboSnapshot } from "../../vebo-snapshot";
import { veboCacheExpiresAt } from "../../vebo-cache";
type Job = { started: number; finished?: number; progress: string; data?: VeboSnapshot; error?: string };
const jobs = new Map<string, Job>();
const cachePath=(key:string)=>path.join(process.env.VEBO_CACHE_DIR??path.join(process.cwd(),".cache","vebo"),`${key}.json`);
async function restore(key:string,network:string,reference:"frame"|"finalized"):Promise<Job|null> {
  try {
    const file=cachePath(key),stat=await fs.stat(file);if(stat.size>100*1024*1024)return null;
    const cached=JSON.parse(await fs.readFile(file,"utf8")) as {finished:number;data:VeboSnapshot};
    if(!Number.isFinite(cached.finished) || cached.finished>Date.now() || Date.now()>=veboCacheExpiresAt(cached,reference) || cached.data.meta.network!==network || cached.data.meta.reference!==reference || cached.data.meta.keyDataVersion!==1 || cached.data.scenario.network!==network || cached.data.scenario.version!==1)return null;
    return {started:cached.finished,finished:cached.finished,progress:"Ready",data:cached.data};
  }catch{return null;}
}
async function persist(key:string,job:Job) {
  try {
    const file=cachePath(key),temporary=`${file}.tmp`;
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
    await fs.writeFile(temporary,JSON.stringify({finished:job.finished,data:job.data}),{mode:0o600});await fs.rename(temporary,file);
  }catch{/* A read-only cache directory must not invalidate an in-memory snapshot. */}
}
async function handleGet(request: NextRequest) {
  const network=request.nextUrl.searchParams.get("network") ?? "mainnet";
  if(network!=="mainnet" && network!=="hoodi")return NextResponse.json({error:"Unknown network"},{status:400});
  const reference=request.nextUrl.searchParams.get("state") ?? "frame";
  if(reference!=="frame" && reference!=="finalized")return NextResponse.json({error:"Unknown state mode"},{status:400});
  const key=`${rpcCacheKey(network)}-${reference}`;
  let job=jobs.get(key);
  if(!job){const cached=await restore(key,network,reference);job=jobs.get(key)??cached??undefined;if(job)jobs.set(key,job);}
  if(!job || (job.finished && Date.now()>=veboCacheExpiresAt({...job,finished:job.finished},reference))) {
    job={started:Date.now(),progress:"Starting snapshot"};jobs.set(key,job);const active=job;
    // The persistent Node runtime keeps this bounded job alive across polls.
    void buildVeboSnapshot(network,message=>{active.progress=message;},reference).then(data=>{active.data=data;active.finished=Date.now();active.progress="Ready";void persist(key,active);}).catch((error:unknown)=>{
      console.error("VEBO snapshot:", error instanceof Error ? error.message.replace(/https?:\/\/[^ ]+/g,"[endpoint]") : "unknown error");
      active.error="Не удалось собрать полный согласованный снимок. Для reference slot может потребоваться архивный Beacon API. Неполный снимок не применяется; можно отдельно загрузить finalized-снимок для сценария.";active.finished=Date.now();
    });
  }
  const cache=job.finished ? {storedAt:job.finished,expiresAt:veboCacheExpiresAt({...job,finished:job.finished},reference)} : undefined;
  return NextResponse.json(job.data ? {status:"ready",...job.data,cache} : job.error ? {status:"error",error:job.error} : {status:"loading",progress:job.progress,started:job.started},{status:job.error ? 503 : job.data ? 200 : 202,headers:{"Cache-Control":"no-store"}});
}

export async function GET(request: NextRequest) { return withRpcSelection(request, handleGet); }
