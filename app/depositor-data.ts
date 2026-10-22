import { Interface, formatEther } from "ethers";

export const LIDO_ABI = new Interface([
  "function getBufferedEther() view returns (uint256)",
  "function getDepositableEther() view returns (uint256)",
  "function getTotalPooledEther() view returns (uint256)",
  "function canDeposit() view returns (bool)",
  "event Unbuffered(uint256 amount)",
]);
export const LOCATOR_ABI = new Interface([
  "function lido() view returns (address)",
  "function depositSecurityModule() view returns (address)",
  "function topUpGateway() view returns (address)",
  "function stakingRouter() view returns (address)",
  "function withdrawalQueue() view returns (address)",
  "function validatorsExitBusOracle() view returns (address)",
]);
export const VEBO_ABI = new Interface([
  "event ValidatorExitRequest(uint256 indexed stakingModuleId,uint256 indexed nodeOperatorId,uint256 indexed validatorIndex,bytes validatorPubkey,uint256 timestamp)",
]);
export const WITHDRAWAL_ABI = new Interface([
  "function unfinalizedStETH() view returns (uint256)",
  "function unfinalizedRequestNumber() view returns (uint256)",
  "function getLockedEtherAmount() view returns (uint256)",
  "function getLastRequestId() view returns (uint256)",
  "function getLastFinalizedRequestId() view returns (uint256)",
  "function isPaused() view returns (bool)",
  "function isBunkerModeActive() view returns (bool)",
  "event WithdrawalsFinalized(uint256 indexed from,uint256 indexed to,uint256 amountOfETHLocked,uint256 sharesToBurn,uint256 timestamp)",
]);
export const GATEWAY_ABI = new Interface([
  "function isPaused() view returns (bool)",
  "function isBlockDistancePassed() view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function TOP_UP_ROLE() view returns (bytes32)",
  "function getRoleMemberCount(bytes32) view returns (uint256)",
  "function getRoleMember(bytes32,uint256) view returns (address)",
  "function getLastTopUpTimestamp() view returns (uint256)",
  "event LastTopUpChanged(uint256 newValue)",
]);
export const DSM_ABI = new Interface([
  "function isDepositsPaused() view returns (bool)",
  "function getLastDepositBlock() view returns (uint256)",
  "event LastDepositBlockChanged(uint256 newValue)",
]);
export const ROUTER_ABI = new Interface(["event StakingRouterETHDeposited(uint256 indexed stakingModuleId,uint256 amount)"]);
export const EDF_ABI = new Interface([
  "function getDelegate() view returns (address)",
  "function owner() view returns (address)",
  "function isTerminated() view returns (bool)",
]);

export type DepositorTransaction = {
  hash: string; block: number; timestamp: number; from: string; to: string | null;
  kind: "deposit" | "topup"; status: "success" | "failed";
  amount: string | null; gasCost: string; gasUsed: string; modules: number[];
};
export type DepositorWallet = {
  holder: string; delegate: string | null; owner: string | null; terminated: boolean | null;
  balance: string | null; holderBalance: string | null;
};
export type WithdrawalFinalization = {
  hash: string; block: number; timestamp: number;
  firstRequestId: string; lastRequestId: string; requests: number; amount: string;
};
export type VeboExitRequest = {
  hash: string; block: number; timestamp: number;
  moduleId: number; nodeOperatorId: string; validatorIndex: string;
};
export type DepositorSnapshot = {
  network: "mainnet" | "hoodi"; chainId: number; explorer: string;
  updatedAt: number; block: number; blockTimestamp: number;
  amounts: { buffer: string; depositable: string; total: string };
  gates: { canDeposit: boolean | null; depositsPaused: boolean | null; topupPaused: boolean | null; topupDistancePassed: boolean | null };
  addresses: { locator: string; lido: string; dsm: string; gateway: string | null; router: string; withdrawalQueue: string; vebo: string };
  withdrawalQueue: {
    demand: string | null; pendingRequests: number | null; claimableEther: string | null;
    lastRequestId: string | null; lastFinalizedRequestId: string | null;
    paused: boolean | null; bunker: boolean | null;
  };
  wallets: DepositorWallet[];
  lastDeposit: { block: number; timestamp: number } | null;
  lastTopup: number | null;
  history: { timestamp: number; blockTimestamp: number | null; buffer: string | null; depositable: string | null; withdrawalDemand: string | null }[];
  withdrawals: WithdrawalFinalization[];
  withdrawalsComplete: boolean;
  veboRequests: VeboExitRequest[];
  veboComplete: boolean;
  transactions: DepositorTransaction[];
  activityFrom: number;
  activityTo: number;
  activityTruncated: boolean;
  warnings: string[];
};

export function ethAmount(wei: string): string {
  return formatEther(BigInt(wei));
}

export function parseVeboExitRequest(log: { topics: string[]; data: string; transactionHash: string; blockNumber: string }): VeboExitRequest {
  const event = VEBO_ABI.parseLog(log);
  if (event?.name !== "ValidatorExitRequest") throw new Error("Not a VEBO exit request");
  return {
    hash: log.transactionHash, block: Number(BigInt(log.blockNumber)), timestamp: Number(event.args[4]),
    moduleId: Number(event.args[0]), nodeOperatorId: String(event.args[1]), validatorIndex: String(event.args[2]),
  };
}

export function parseFinalization(log: { topics: string[]; data: string; transactionHash: string; blockNumber: string }): WithdrawalFinalization {
  const event = WITHDRAWAL_ABI.parseLog(log);
  if (event?.name !== "WithdrawalsFinalized") throw new Error("Not a withdrawal finalization");
  const from = BigInt(event.args[0]);
  const to = BigInt(event.args[1]);
  const amount = BigInt(event.args[2]);
  const timestamp = Number(event.args[4]);
  if (from < BigInt(1) || to < from) throw new Error("Invalid finalization range");
  return {
    hash: log.transactionHash, block: Number(BigInt(log.blockNumber)), timestamp: Number(timestamp),
    firstRequestId: String(from), lastRequestId: String(to), requests: Number(to - from + BigInt(1)),
    amount: ethAmount(String(amount)),
  };
}

export function unbufferedAmount(logs: { address: string; topics: readonly string[]; data: string }[], lido: string): string | null {
  let total = BigInt(0);
  let found = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== lido.toLowerCase()) continue;
    try {
      const event = LIDO_ABI.parseLog({ topics: [...log.topics], data: log.data });
      if (event?.name === "Unbuffered") { total += event.args[0]; found = true; }
    } catch { /* Other Lido events are irrelevant. */ }
  }
  return found ? formatEther(total) : null;
}
