import { AbiCoder, Interface, decodeBytes32String } from "ethers";

export type CouncilChain = "ethereum" | "gnosis" | "polygon";
export type CouncilKind = "deposit" | "ping" | "pause" | "unvet" | "resume";
export const COUNCIL_CHAINS = {
  ethereum: { name: "Ethereum", chainId: 1, symbol: "ETH", explorer: "https://etherscan.io", seconds: 12 },
  gnosis: { name: "Gnosis", chainId: 100, symbol: "xDAI", explorer: "https://gnosis.blockscout.com", seconds: 5 },
  polygon: { name: "Polygon", chainId: 137, symbol: "POL", explorer: "https://polygonscan.com", seconds: 2 },
} as const;
export const COUNCIL_BUS = "0x37De961D6bb5865867aDd416be07189D2Dd960e6";
export const COUNCIL_LOCATOR = "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb";
export const COUNCIL_LABEL_SOURCE = "https://research.lido.fi/t/lip-37-execution-delegation-framework-edf/11746/26";
// Operator names and pre-EDF identities published in the governance migration.
// Membership and current wallet addresses are always read from the chain.
export const COUNCIL_LABELS: Record<string, { name: string; legacy: string }> = Object.fromEntries([
  ["0x915F0Fa50E1af761B113b41c79ab33Bf4734C36E", "Lido dev team", "0x5fd0dDbC3351d009eb3f88DE7Cd081a614C519F1"],
  ["0xe387Ba1d5C9f6306eCe9ac949C7fB6233dD5411E", "P2P", "0xa56b128Ea2Ea237052b0fA2a96a387C0E43157d8"],
  ["0x35506190Ca6df385aA6Bc4a970646dd4f49426c1", "Staking Facilities", "0xf82D88217C249297C6037BA77CE34b3d8a90ab43"],
  ["0xDc1579636686C082fc3b00B9EB25259A110D0C44", "Blockscape", "0x7912Fa976BcDe9c2cf728e213e892AD7588E6AaF"],
  ["0x031E597BcF680f1f2293b119b4b2B14096B15497", "Stakefish", "0x4B87F16B8d32cb5a859a4C48a88edB5adBe3498E"],
  ["0x6A22d74a816662078f2371A7138E7614874cd61d", "Stakely", "0x6d22aE126eB2c37F67a1391B37FF4f2863e61389"],
].map(([address, name, legacy]) => [address.toLowerCase(), { name, legacy: legacy.toLowerCase() }]));

export const COUNCIL_DSM = new Interface([
  "function getGuardians() view returns(address[])", "function getGuardianQuorum() view returns(uint256)",
  "function isDepositsPaused() view returns(bool)", "function getLastDepositBlock() view returns(uint256)",
  "function getPauseIntentValidityPeriodBlocks() view returns(uint256)", "function getMaxOperatorsPerUnvetting() view returns(uint256)",
  "event DepositsPaused(address indexed guardian)", "event DepositsUnpaused()", "event LastDepositBlockChanged(uint256 newValue)",
  "function pauseDeposits(uint256 blockNumber,(address guardian,bytes signature) sig)",
  "function unpauseDeposits()",
  "function unvetSigningKeys(uint256 blockNumber,bytes32 blockHash,uint256 stakingModuleId,uint256 nonce,bytes nodeOperatorIds,bytes vettedSigningKeysCounts,(address guardian,bytes signature) sig)",
  "function depositBufferedEther(uint256 blockNumber,bytes32 blockHash,bytes32 depositRoot,uint256 stakingModuleId,uint256 nonce,(address guardian,bytes signature)[] sortedGuardianSignatures)",
]);
export const COUNCIL_EDF = new Interface([
  "function getDelegate() view returns(address)", "function owner() view returns(address)",
  "function isTerminated() view returns(bool)", "function getPendingDelegate() view returns(address,uint256)",
  "function execute(address target,bytes data) payable returns(bytes)",
  "event DelegateNominated(address indexed newDelegate,uint256 activeFrom)",
  "event DelegateRevoked(address indexed revokedDelegate)",
]);
export const COUNCIL_BUS_ABI = new Interface([
  "event MessageDepositV2(address indexed guardianAddress,(uint256 blockNumber,bytes32 blockHash,bytes32 depositRoot,uint256 stakingModuleId,uint256 nonce,bytes signature,(bytes32 version) app) data)",
  "event MessagePauseV4(address indexed guardianAddress,(uint256 blockNumber,bytes32 blockHash,bytes signature,(bytes32 version) app) data)",
  "event MessageUnvetV2(address indexed guardianAddress,(uint256 blockNumber,bytes32 blockHash,uint256 stakingModuleId,uint256 nonce,bytes operatorIds,bytes vettedKeysByOperator,bytes signature,(bytes32 version) app) data)",
  "event MessageDepositV1(address indexed guardianAddress,(uint256 blockNumber,bytes32 blockHash,bytes32 depositRoot,uint256 stakingModuleId,uint256 nonce,(bytes32 r,bytes32 vs) signature,(bytes32 version) app) data)",
  "event MessagePauseV2(address indexed guardianAddress,(uint256 blockNumber,bytes32 blockHash,(bytes32 r,bytes32 vs) signature,uint256 stakingModuleId,(bytes32 version) app) data)",
  "event MessagePauseV3(address indexed guardianAddress,(uint256 blockNumber,bytes32 blockHash,(bytes32 r,bytes32 vs) signature,(bytes32 version) app) data)",
  "event MessagePingV1(address indexed guardianAddress,(uint256 blockNumber,(bytes32 version) app) data)",
  "event MessageUnvetV1(address indexed guardianAddress,(uint256 blockNumber,bytes32 blockHash,uint256 stakingModuleId,uint256 nonce,bytes operatorIds,bytes vettedKeysByOperator,(bytes32 r,bytes32 vs) signature,(bytes32 version) app) data)",
]);
export type CouncilLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string; blockTimestamp?: string };
export type CouncilEvent = {
  id: string; chain: CouncilChain; kind: CouncilKind; stage: "message" | "execution";
  hash: string; block: number; timestamp: number; sender: string;
  guardian: string | null; guardians: string[]; currentKey: boolean;
  moduleId: number | null; referenceBlock: number | null; version: string | null;
  success: boolean; payload: Record<string, unknown>;
};
export type CouncilGuardian = {
  address: string; name: string; wallet: string | null; owner: string | null;
  terminated: boolean | null; pendingDelegate: string | null; pendingFrom: number | null;
  legacy: string | null; balances: Record<CouncilChain, string | null>;
};
export type CouncilHead = { block: number; timestamp: number };
export type CouncilSnapshot = {
  updatedAt: number; dsm: string; quorum: number; paused: boolean; guardians: CouncilGuardian[];
  heads: Partial<Record<CouncilChain, CouncilHead>>;
  lastDeposit: CouncilHead | null; pauseValidityBlocks: number | null; maxOperatorsPerUnvet: number | null;
  warnings: string[];
};
export type CouncilDaily = { timestamp: number; deposit: number; ping: number; pause: number; unvet: number; executions: number };
export type CouncilActivity = {
  updatedAt: number; from: number; to: number; events: CouncilEvent[]; total: number;
  daily: CouncilDaily[]; coverage: Record<CouncilChain, boolean>; dsmHistoryComplete: boolean;
  members: { guardian: string; messages: number; deposits: number; pings: number; daily: number[]; dailyPings: number[]; last: CouncilEvent | null; lastCurrent: CouncilEvent | null }[];
  totals: { messages: number; deposits: number; pings: number; pauseMessages: number; unvetMessages: number; pauses: number; unvets: number; depositsExecuted: number; failed: number };
  warnings: string[];
};

export function parseCouncilBus(log: CouncilLog, chain: CouncilChain, timestamp: number): CouncilEvent {
  const bytes = AbiCoder.defaultAbiCoder().decode(["bytes"], log.data)[0];
  const decoded = COUNCIL_BUS_ABI.parseLog({ topics: log.topics, data: bytes });
  if (!decoded) throw new Error("Unrecognized Council message");
  const payload = decoded.args.data;
  const kind = decoded.name.startsWith("MessageDeposit") ? "deposit" : decoded.name.startsWith("MessagePing") ? "ping" : decoded.name.startsWith("MessagePause") ? "pause" : "unvet";
  let version: string | null = null;
  try { version = decodeBytes32String(payload.app.version); } catch { /* Preserve the record even if version text is malformed. */ }
  const moduleId = payload.stakingModuleId === undefined ? null : Number(payload.stakingModuleId);
  return {
    id: `${chain}:${log.transactionHash}:${log.logIndex}`, chain, kind, stage: "message",
    hash: log.transactionHash, block: Number(BigInt(log.blockNumber)), timestamp,
    sender: String(decoded.args.guardianAddress).toLowerCase(), guardian: null, guardians: [], currentKey: false,
    moduleId, referenceBlock: Number(payload.blockNumber), version, success: true,
    payload: {
      event: decoded.name, referenceBlock: String(payload.blockNumber), version,
      ...(moduleId === null ? {} : { moduleId, nonce: payload.nonce === undefined ? null : String(payload.nonce) }),
      ...(payload.blockHash === undefined ? {} : { blockHash: payload.blockHash }),
      ...(payload.depositRoot === undefined ? {} : { depositRoot: payload.depositRoot }),
      ...(payload.operatorIds === undefined ? {} : { operatorIds: unpackCouncilBytes(payload.operatorIds, 8), vettedKeysCounts: unpackCouncilBytes(payload.vettedKeysByOperator, 16) }),
    },
  };
}

export function unpackCouncilBytes(bytes: string, size: number) {
  const hex = bytes.slice(2);
  if (hex.length % (size * 2)) throw new Error("Invalid packed Council payload");
  return Array.from({ length: hex.length / (size * 2) }, (_, i) => BigInt(`0x${hex.slice(i * size * 2, (i + 1) * size * 2)}`).toString());
}

export function decodeCouncilDsm(tx: { to: string | null; from: string; input: string }, dsm: string) {
  let target = tx.to?.toLowerCase(), input = tx.input;
  let caller = tx.from.toLowerCase();
  if (target !== dsm.toLowerCase()) {
    try {
      const wrapper = COUNCIL_EDF.parseTransaction({ data: input });
      if (wrapper?.name !== "execute") return null;
      caller = target ?? caller; target = String(wrapper.args.target).toLowerCase(); input = wrapper.args.data;
    } catch { return null; }
  }
  if (target !== dsm.toLowerCase()) return null;
  let decoded;
  try { decoded = COUNCIL_DSM.parseTransaction({ data: input }); } catch { return null; }
  if (!decoded) return null;
  const kind: CouncilKind | null = decoded.name === "pauseDeposits" ? "pause" : decoded.name === "unvetSigningKeys" ? "unvet" : decoded.name === "depositBufferedEther" ? "deposit" : decoded.name === "unpauseDeposits" ? "resume" : null;
  if (!kind) return null;
  const sig = decoded.args.sig;
  const guardian = sig && sig.guardian !== "0x0000000000000000000000000000000000000000" ? String(sig.guardian).toLowerCase() : caller;
  return {
    kind, guardian, guardians: decoded.args.sortedGuardianSignatures ? Array.from(decoded.args.sortedGuardianSignatures, (s: { guardian: string }) => s.guardian.toLowerCase()) : [guardian],
    moduleId: decoded.args.stakingModuleId === undefined ? null : Number(decoded.args.stakingModuleId),
    referenceBlock: decoded.args.blockNumber === undefined ? null : Number(decoded.args.blockNumber),
    payload: {
      method: decoded.name, caller, nonce: decoded.args.nonce === undefined ? null : String(decoded.args.nonce),
      ...(kind === "unvet" ? { operatorIds: unpackCouncilBytes(decoded.args.nodeOperatorIds, 8), vettedKeysCounts: unpackCouncilBytes(decoded.args.vettedSigningKeysCounts, 16) } : {}),
    },
  };
}

// Streaming statistics avoid retaining every high-volume attestation payload.
export class CouncilStatistics {
  from: number;
  to: number;
  total = 0;
  daily: CouncilDaily[];
  members: CouncilActivity["members"];
  totals: CouncilActivity["totals"] = { messages: 0, deposits: 0, pings: 0, pauseMessages: 0, unvetMessages: 0, pauses: 0, unvets: 0, depositsExecuted: 0, failed: 0 };
  constructor(guardians: CouncilGuardian[], now: number) {
    this.to = now;
    this.from = Math.floor(now / 86400) * 86400 - 6 * 86400;
    this.daily = Array.from({ length: 7 }, (_, i) => ({ timestamp: this.from + i * 86400, deposit: 0, ping: 0, pause: 0, unvet: 0, executions: 0 }));
    this.members = guardians.map(g => ({ guardian: g.address.toLowerCase(), messages: 0, deposits: 0, pings: 0, daily: Array(7).fill(0), dailyPings: Array(7).fill(0), last: null, lastCurrent: null }));
  }
  add(e: CouncilEvent) {
    if (e.timestamp < this.from || e.timestamp > this.to) return false;
    this.total++;
    const bucket = this.daily[Math.floor((e.timestamp - this.from) / 86400)];
    if (e.stage === "message" && e.kind !== "resume") {
      bucket[e.kind]++; this.totals.messages++;
      if (e.kind === "deposit") this.totals.deposits++;
      if (e.kind === "ping") this.totals.pings++;
      if (e.kind === "pause") this.totals.pauseMessages++;
      if (e.kind === "unvet") this.totals.unvetMessages++;
      const member = this.members.find(m => m.guardian === e.guardian);
      if (member) {
        member.messages++;
        const day = Math.floor((e.timestamp - this.from) / 86400);
        member.daily[day]++;
        if (e.kind === "ping") member.dailyPings[day]++;
        if (e.kind === "deposit") member.deposits++;
        if (e.kind === "ping") member.pings++;
        if (!member.last || e.timestamp > member.last.timestamp) member.last = e;
        if (e.currentKey && (!member.lastCurrent || e.timestamp > member.lastCurrent.timestamp)) member.lastCurrent = e;
      }
    } else if (e.success) {
      bucket.executions++;
      if (e.kind === "pause") this.totals.pauses++;
      if (e.kind === "unvet") this.totals.unvets++;
      if (e.kind === "deposit") this.totals.depositsExecuted++;
    }
    if (!e.success) this.totals.failed++;
    return true;
  }
  finish(events: CouncilEvent[]) {
    return { from: this.from, to: this.to, total: this.total, daily: this.daily, totals: this.totals, members: this.members, events };
  }
}

export function summarizeCouncil(events: CouncilEvent[], guardians: CouncilGuardian[], now: number) {
  const stats = new CouncilStatistics(guardians, now);
  const scoped = events.filter(e => stats.add(e)).sort((a,b) => b.timestamp - a.timestamp || b.block - a.block);
  let broadcasts = 0, calls = 0;
  return stats.finish(scoped.filter(e => e.stage === "message" ? broadcasts++ < 500 : calls++ < 100));
}
