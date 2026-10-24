import type { WithdrawalFinalization } from "./depositor-data";
export function withdrawalDays(events:WithdrawalFinalization[],now:number){
  const today=Math.floor(now/86400)*86400;
  return Array.from({length:7},(_,i)=>{
    const timestamp=today-(6-i)*86400;
    const matching=events.filter(e=>e.timestamp>=timestamp&&e.timestamp<timestamp+86400);
    return {timestamp,eth:matching.reduce((sum,e)=>sum+Number(e.amount),0),requests:matching.reduce((sum,e)=>sum+e.requests,0),reports:matching.length};
  });
}
