// Scenario implementation of lido-oracle's ValidatorExitIterator. Amounts are
// rounded to Gwei; report funding is an explicit user assumption, not a CL forecast.
export type ExitMode = "none" | "soft" | "force";
export type SimModule = { id: number; name: string; exitShareBps: number };
export type SimValidator = { index: number; pubkey?: string; balanceETH: number; maxEffectiveETH: 32 | 2048 };
export type SimOperator = {
  id: string; moduleId: number; name: string; validators: number; excluded: number; pending: number;
  balanceETH: number; credential: "0x01" | "0x02"; weight: number; mode: ExitMode; target: number; indexStart: number;
  validatorData?: SimValidator[]; pendingBalanceETH?: number;
};
export type SimGroup = { name: string; external: string[]; internal: { operatorId: string; shareBps: number }[] };
export type ExitScenario = {
  version: 1; network: "mainnet" | "hoodi"; demandETH: number; availableETH: number; incomingETH: number;
  rewardsETH: number; depositLockETH: number; growthETH: number; maxRequests: number; maxExitETH: number;
  reports: number; frameHours: number; modules: SimModule[]; operators: SimOperator[]; groups: SimGroup[];
};
export type Candidate = {
  operatorId: string; moduleId: number; name: string; validator: SimValidator;
  force: number; soft: number; modulePriority: number; deviationETH: number; targetStakeETH: number; stakeETH: number;
};
export type ExitStep = { order: number; phase: "demand" | "forced"; winner: Candidate; runner: Candidate | null; criterion: number; predictedETH: number; budgetETH: number };
export type SimReport = {
  index: number; steps: ExitStep[]; demandETH: number; fundingETH: number; exitETH: number; budgetETH: number;
  cumulativeETH: number; remainingETH: number; stop: "demand" | "requests" | "sanity" | "exhausted";
  blocked: Candidate | null; byOperator: Record<string, number>;
};
const gwei = (eth: number) => Math.round(eth * 1e9);
const eth = (value: number) => value / 1e9;
const scalarBounds = {
  demandETH: [0, 1e7], availableETH: [0, 1e7], incomingETH: [0, 1e7], rewardsETH: [0, 1e7], depositLockETH: [0, 1e7], growthETH: [0, 1e6],
  maxRequests: [0, 2000], maxExitETH: [0, 1e7], reports: [1, 24], frameHours: [.1, 168],
} as const;
export function validateScenario(input: unknown): ExitScenario {
  if (!input || typeof input !== "object") throw new Error("Expected a scenario object");
  const s = input as ExitScenario;
  const num = (value: unknown, min: number, max: number, label: string, integer = false) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid ${label}: expected ${min}–${max}${integer ? ' (integer)' : ''}`);
  };
  if (s.version !== 1 || !["mainnet", "hoodi"].includes(s.network)) throw new Error("Unsupported scenario version or network");
  for (const [key, [min, max]] of Object.entries(scalarBounds)) num(s[key as keyof typeof scalarBounds], min, max, key, key === "reports" || key === "maxRequests");
  if (!Array.isArray(s.modules) || !s.modules.length || s.modules.length > 20 || !Array.isArray(s.operators) || s.operators.length > 5000 || !Array.isArray(s.groups) || s.groups.length > 1000) throw new Error("Invalid module, operator or group list");
  const modules = new Set<number>(), ids = new Set<string>(), indexes = new Set<number>(), pubkeys = new Set<string>();
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 512;
  for (const m of s.modules) {
    num(m.id, 1, 1e6, "module ID", true); num(m.exitShareBps, 0, 10000, "exit share", true);
    if (modules.has(m.id) || !text(m.name)) throw new Error("Duplicate module or invalid name"); modules.add(m.id);
  }
  for (const o of s.operators) {
    if (!text(o.id) || !/^\d+:\d+$/.test(o.id) || Number(o.id.split(":")[0]) !== o.moduleId || !text(o.name) || ids.has(o.id) || !modules.has(o.moduleId)) throw new Error("Invalid or duplicate operator"); ids.add(o.id);
    for (const k of ["validators", "excluded", "pending", "target"] as const) num(o[k], 0, 1e6, k, true);
    num(o.weight, 0, 1e9, "weight"); num(o.indexStart, 0, 1e10, "validator index", true);
    if (o.excluded > o.validators || !["none", "soft", "force"].includes(o.mode) || !["0x01", "0x02"].includes(o.credential)) throw new Error("Invalid operator mode, credentials or exclusions");
    num(o.balanceETH, 0, o.credential === "0x01" ? 32 : 2048, "predictable validator balance");
    if (o.pendingBalanceETH !== undefined) num(o.pendingBalanceETH,0,1e8,"pending stake");
    if (o.validatorData) {
      if (!Array.isArray(o.validatorData) || o.validatorData.length > 1000000 || o.validatorData.length !== o.validators - o.excluded) throw new Error("Explicit validators must match the eligible count");
      for (const v of o.validatorData) {
        num(v.index, 0, 1e10, "validator index", true); if (indexes.has(v.index)) throw new Error("Duplicate explicit validator index"); indexes.add(v.index);
        if (v.pubkey !== undefined) {
          if (typeof v.pubkey !== "string" || !/^0x[\da-f]{96}$/i.test(v.pubkey)) throw new Error("Invalid validator public key");
          const key = v.pubkey.toLowerCase();
          if (pubkeys.has(key)) throw new Error("Duplicate validator public key");
          pubkeys.add(key);
        }
        if (![32, 2048].includes(v.maxEffectiveETH)) throw new Error("Invalid validator cap"); num(v.balanceETH, 0, v.maxEffectiveETH, "validator balance");
      }
    }
  }
  if (s.operators.reduce((n,o) => n+(o.validatorData?.length ?? 0),0)>1000000) throw new Error("Too many validators");
  // Generated index ranges must also be globally unique for deterministic ties.
  const ranges = s.operators.filter(o => !o.validatorData && o.validators > o.excluded).map(o => [o.indexStart, o.indexStart + o.validators - o.excluded - 1]).sort((a,b) => a[0]-b[0]);
  for (let i=1;i<ranges.length;i++) if (ranges[i][0] <= ranges[i-1][1]) throw new Error("Generated validator index ranges overlap");
  for (const index of indexes) if (ranges.some(([lo,hi]) => index >= lo && index <= hi)) throw new Error("Explicit and generated validator indexes overlap");
  const grouped = new Set<string>();
  for (const group of s.groups) {
    if (typeof group.name !== "string" || group.name.length > 512 || !Array.isArray(group.external) || !Array.isArray(group.internal) || group.external.length > 100 || group.internal.length > 100) throw new Error("Invalid operator group");
    const internalModules = new Set(group.internal.map(i => s.operators.find(o => o.id === i.operatorId)?.moduleId));
    const externalModules = new Set(group.external.map(id => s.operators.find(o => o.id === id)?.moduleId));
    if (internalModules.size > 1 || externalModules.size > 1 || [...internalModules].some(id => externalModules.has(id))) throw new Error("A group must connect distinct curated modules");
    for (const id of [...group.external, ...group.internal.map(i => i.operatorId)]) {
      if (!ids.has(id) || grouped.has(id)) throw new Error("Unknown operator or operator in multiple groups"); grouped.add(id);
    }
    for (const i of group.internal) num(i.shareBps, 0, 10000, "group share", true);
    if (group.internal.length && group.internal.reduce((sum,i) => sum+i.shareBps,0) !== 10000) throw new Error("Internal group shares must total 10000 bps");
  }
  return structuredClone(s);
}
export function exampleScenario(network: "mainnet" | "hoodi" = "mainnet"): ExitScenario {
  return {
    version: 1, network, demandETH: 16000, availableETH: 1200, incomingETH: 800, rewardsETH: 160, depositLockETH: 0, growthETH: 320,
    maxRequests: 120, maxExitETH: 4096, reports: 8, frameHours: 4.8,
    modules: [{ id: 1, name: "Curated", exitShareBps: 7000 }, { id: 3, name: "Community", exitShareBps: 3000 }],
    operators: [
      { id: "1:0", moduleId: 1, name: "Operator Alpha", validators: 500, excluded: 0, pending: 0, balanceETH: 32, credential: "0x01", weight: 100, mode: "none", target: 0, indexStart: 100000 },
      { id: "1:1", moduleId: 1, name: "Operator Beta", validators: 320, excluded: 0, pending: 0, balanceETH: 32, credential: "0x01", weight: 100, mode: "soft", target: 280, indexStart: 200000 },
      { id: "1:2", moduleId: 1, name: "Operator Gamma", validators: 220, excluded: 0, pending: 0, balanceETH: 32, credential: "0x01", weight: 100, mode: "force", target: 200, indexStart: 300000 },
      { id: "3:0", moduleId: 3, name: "Operator Delta", validators: 240, excluded: 0, pending: 0, balanceETH: 32, credential: "0x01", weight: 100, mode: "none", target: 0, indexStart: 400000 },
      { id: "3:1", moduleId: 3, name: "Operator Epsilon", validators: 140, excluded: 0, pending: 0, balanceETH: 32, credential: "0x01", weight: 100, mode: "none", target: 0, indexStart: 500000 },
    ], groups: [],
  };
}
type OpState = { input: SimOperator; count: number; eligible: number; cursor: number; balance: number; stake: number; weight: number; explicit: SimValidator[] | null };
type ModState = { input: SimModule; balance: number; stake: number; weight: number };
export const PREDICATES = ["Forced excess", "Soft excess", "Module exit priority", "Stake above weighted target", "Lowest validator index"];
export function compareCandidates(a: Candidate, b: Candidate, forcedOnly = false) {
  const aa = forcedOnly ? [-a.force, a.validator.index] : [-a.force, -a.soft, -a.modulePriority, -a.deviationETH, a.validator.index];
  const bb = forcedOnly ? [-b.force, b.validator.index] : [-b.force, -b.soft, -b.modulePriority, -b.deviationETH, b.validator.index];
  for (let i=0;i<aa.length;i++) if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  return 0;
}
export function simulateExits(s: ExitScenario): SimReport[] {
  const modules = new Map<number, ModState>(s.modules.map(m => [m.id, { input: m, balance: 0, stake: 0, weight: 0 }]));
  const operators = new Map<string, OpState>();
  let total = 0;
  for (const o of s.operators) {
    const eligible = o.validators - o.excluded, explicit = o.validatorData ? [...o.validatorData].sort((a,b) => a.index-b.index) : null;
    const balance = (explicit ? explicit.reduce((sum,v) => sum+gwei(v.balanceETH),0) : eligible*gwei(o.balanceETH)) + (o.pendingBalanceETH === undefined ? o.pending*gwei(o.balanceETH) : gwei(o.pendingBalanceETH));
    const op: OpState = { input:o, count:eligible+o.pending, eligible, cursor:0, balance, stake:balance, weight:o.weight, explicit };
    operators.set(o.id,op); const m=modules.get(o.moduleId)!; m.balance+=balance; m.stake+=balance; total+=balance;
  }
  const connections = s.groups.filter(g => g.external.length && g.internal.length);
  for (const group of connections) {
    const external = group.external.map(id => operators.get(id)!), internal = group.internal.map(i => operators.get(i.operatorId)!);
    const eb=external.reduce((n,o) => n+o.balance,0), ib=internal.reduce((n,o) => n+o.balance,0), iw=internal.reduce((n,o) => n+o.weight,0);
    internal.forEach((o,i) => { o.stake += eb*(iw ? o.weight/iw : group.internal[i].shareBps/10000); });
    external.forEach(o => { o.stake += ib/external.length; o.weight=iw/external.length; });
    modules.get(external[0].input.moduleId)!.stake += ib; modules.get(internal[0].input.moduleId)!.stake += eb;
  }
  for (const o of operators.values()) modules.get(o.input.moduleId)!.weight += o.weight;
  function candidate(o: OpState): Candidate {
    const m=modules.get(o.input.moduleId)!, threshold=Math.floor(m.input.exitShareBps/10000*total), target=m.weight ? m.stake*o.weight/m.weight : 0;
    const validator=o.explicit?.[o.cursor] ?? { index:o.input.indexStart+o.cursor, balanceETH:o.input.balanceETH, maxEffectiveETH:o.input.credential === "0x01" ? 32 : 2048 };
    return { operatorId:o.input.id,moduleId:o.input.moduleId,name:o.input.name,validator,
      force:o.input.mode === "force" ? Math.max(0,o.count-o.input.target) : 0,
      soft:o.input.mode === "soft" ? Math.max(0,o.count-o.input.target) : 0,
      modulePriority:m.balance === 0 ? -2 : m.balance > threshold ? m.balance-threshold : -1/m.balance,
      deviationETH:eth(o.stake-target),targetStakeETH:eth(target),stakeETH:eth(o.stake) };
  }
  function remove(op: OpState, amount: number) {
    op.eligible--; op.count--; op.cursor++; op.balance-=amount; op.stake-=amount; total-=amount;
    const m=modules.get(op.input.moduleId)!; m.balance-=amount; m.stake-=amount;
    for (const group of connections) {
      if (group.internal.some(i => i.operatorId === op.input.id)) {
        const external=group.external.map(id => operators.get(id)!);
        modules.get(external[0].input.moduleId)!.stake-=amount;
        external.forEach(o => {o.stake-=amount/external.length;});
      }
      if (group.external.includes(op.input.id)) {
        const internal=group.internal.map(i => operators.get(i.operatorId)!), weight=internal.reduce((n,o) => n+o.weight,0);
        modules.get(internal[0].input.moduleId)!.stake-=amount;
        internal.forEach((o,i) => {o.stake-=amount*(weight ? o.weight/weight : group.internal[i].shareBps/10000);});
      }
    }
  }
  const result: SimReport[]=[]; let committed=0;
  for (let i=0;i<s.reports;i++) {
    const demand=gwei(s.demandETH+i*s.growthETH), funding=gwei(s.availableETH+s.incomingETH+s.rewardsETH-s.depositLockETH)+committed;
    const report: SimReport={index:i+1,steps:[],demandETH:eth(demand),fundingETH:eth(funding),exitETH:0,budgetETH:0,cumulativeETH:eth(committed),remainingETH:0,stop:"demand",blocked:null,byOperator:{}};
    let moved=0,budget=0;
    while (true) {
      const forcedOnly = demand === 0 || funding+moved >= demand;
      const candidates: Candidate[]=[];
      for (const op of operators.values()) {
        if (!op.eligible) continue;
        const c=candidate(op); if (forcedOnly && c.force===0) continue;
        if (!candidates[0] || compareCandidates(c,candidates[0],forcedOnly)<0) {candidates[1]=candidates[0]; candidates[0]=c;}
        else if (!candidates[1] || compareCandidates(c,candidates[1],forcedOnly)<0) candidates[1]=c;
      }
      if (!candidates.length) {report.stop=forcedOnly ? "demand" : "exhausted";break;}
      if (report.steps.length>=s.maxRequests) {report.stop="requests"; report.blocked=candidates[0];break;}
      const winner=candidates[0], runner=candidates[1] ?? null;
      if (budget+gwei(winner.validator.maxEffectiveETH)>gwei(s.maxExitETH)) {report.stop="sanity";report.blocked=winner;break;}
      const criteria=forcedOnly ? [0,4] : [0,1,2,3,4];
      const values=(c:Candidate)=>[c.force,c.soft,c.modulePriority,c.deviationETH,c.validator.index];
      const criterion=runner ? criteria.find(k=>values(winner)[k]!==values(runner)[k]) ?? 4 : -1;
      moved+=gwei(winner.validator.balanceETH); budget+=gwei(winner.validator.maxEffectiveETH);
      report.steps.push({order:report.steps.length+1,phase:forcedOnly ? "forced" : "demand",winner,runner,criterion,predictedETH:eth(moved),budgetETH:eth(budget)});
      report.byOperator[winner.operatorId]=(report.byOperator[winner.operatorId] ?? 0)+1;
      remove(operators.get(winner.operatorId)!,gwei(winner.validator.balanceETH));
    }
    committed+=moved; report.exitETH=eth(moved);report.budgetETH=eth(budget);report.cumulativeETH=eth(committed);report.remainingETH=eth(Math.max(0,demand-funding-moved));result.push(report);
  }
  return result;
}
