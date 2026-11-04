import type {BusMessage, Snapshot} from './oracle-snapshot-data.ts';
import {DATA_REFRESH_INTERVAL_MS} from './refresh-policy.ts';

// Overview uses only the latest heartbeat, diagnostic and startup per identity.
// Full ledger payloads stay on the telemetry route.
export function compactOracleMessages(messages: BusMessage[]) {
  const selected=new Map<string,BusMessage>();
  for(const message of messages){
    const identity=`${message.memberAddress??message.holderAddress??message.sender}:${message.module}`;
    const buckets=message.event==='startup'?['startup']:message.event==='diagnostic'?['latest','diagnostic']:['latest'];
    for(const bucket of buckets){const key=`${identity}:${bucket}`,previous=selected.get(key);if(!previous||message.blockNumber>previous.blockNumber)selected.set(key,message);}
  }
  return [...new Map([...selected.values()].map(message=>[`${message.transactionHash}:${message.module}`,message])).values()].sort((a,b)=>b.blockNumber-a.blockNumber);
}
export type OracleSnapshotResult={status:'loading'|'ready'|'error';snapshot?:Snapshot;storedAt:number;expiresAt:number;error?:string};
export function createOracleSnapshotCache(now=Date.now){
 const jobs=new Map<string,OracleSnapshotResult>();
 return {
  read(key:string,collect:(progress:(snapshot:Snapshot)=>void)=>Promise<Snapshot>):OracleSnapshotResult{
   const previous=jobs.get(key);
   if(previous&&now()<previous.expiresAt)return previous;
   const started=now(),job:OracleSnapshotResult={status:'loading',storedAt:started,expiresAt:started+DATA_REFRESH_INTERVAL_MS};
   jobs.set(key,job);
   // Bound completed entries while leaving active collections deduplicated.
   for(const [old,value] of jobs){if(jobs.size<=8)break;if(old!==key&&value.status!=='loading')jobs.delete(old);}
   void Promise.resolve().then(()=>collect(snapshot=>{if(jobs.get(key)===job)job.snapshot=snapshot;})).then(snapshot=>{
    if(jobs.get(key)===job){job.snapshot=snapshot;job.status='ready';}
   }).catch(()=>{if(jobs.get(key)===job){job.status='error';job.error='Oracle collection failed. Choose Auto or another RPC; the next refresh retries automatically.';}});
   return job;
  }
 };
}
