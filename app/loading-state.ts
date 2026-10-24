export type LoadingNetwork = "mainnet" | "hoodi";
export type LoadingTaskState = "loading" | "ready" | "error";
export type LoadingSummary = { total:number; pending:number; errors:number; pendingLabels:string[]; errorLabels:string[] };
const empty:LoadingSummary={total:0,pending:0,errors:0,pendingLabels:[],errorLabels:[]};
export function createLoadingRegistry() {
  const tasks=new Map<string,{network:LoadingNetwork;label:string;state:LoadingTaskState}>(),listeners=new Set<()=>void>();
  const snapshots:Record<LoadingNetwork,LoadingSummary>={mainnet:empty,hoodi:empty};
  function publish(){
    for(const network of ["mainnet","hoodi"] as const){
      const rows=[...tasks.values()].filter(task=>task.network===network);
      const next={total:rows.length,pending:rows.filter(t=>t.state==='loading').length,errors:rows.filter(t=>t.state==='error').length,pendingLabels:[...new Set(rows.filter(t=>t.state==='loading').map(t=>t.label))],errorLabels:[...new Set(rows.filter(t=>t.state==='error').map(t=>t.label))]};
      if(JSON.stringify(next)!==JSON.stringify(snapshots[network]))snapshots[network]=next;
    }
    listeners.forEach(listener=>listener());
  }
  return {
    update(id:string,network:LoadingNetwork,label:string,state:LoadingTaskState){
      const old=tasks.get(id);if(old?.network===network&&old.label===label&&old.state===state)return;
      tasks.set(id,{network,label,state});publish();
    },
    remove(id:string){if(tasks.delete(id))publish();},
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    snapshot(network:LoadingNetwork){return snapshots[network];},
    serverSnapshot(){return empty;},
  };
}
