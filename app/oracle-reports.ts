import { type EventFragment, formatUnits, Interface } from "ethers";

import type { OracleModule } from "./oracle-modules";

export type { OracleModule };

export type ReportField = {
  label: string;
  value: string;
  description: string;
  mono?: boolean;
};

export type VeboOperatorSummary = {
  moduleId: number;
  operatorId: string;
  operatorName?: string;
  validatorCount: number;
  nominalEth: number;
  validatorIndices: string[];
  keyIndices: string[];
  pubkeys: string[];
};

// A report goes through up to three phases (see the Accounting module in
// lido-oracle): every member votes for the report hash in HashConsensus, one
// member submits the report data, and for the Accounting Oracle the extra
// data follows.
export type ReportPhase = "hash" | "data" | "extra";

export const REPORT_PHASES: ReadonlyArray<{
  key: ReportPhase;
  label: string;
  full: string;
}> = [
  { key: "hash", label: "Hash", full: "Phase 1 · report hash" },
  { key: "data", label: "Data", full: "Phase 2 · report data" },
  { key: "extra", label: "Extra data", full: "Phase 3 · extra data" },
];

// How many latest frames of hash votes the report API returns per module.
// Every frame has one vote per committee member, so the depth is limited.
export const HASH_VOTE_FRAMES: readonly number[] = [10, 20, 40];
export const DEFAULT_HASH_VOTE_FRAMES = 10;

export function safeHashVoteFrames(value: string | null) {
  const frames = Number(value);
  return HASH_VOTE_FRAMES.includes(frames) ? frames : DEFAULT_HASH_VOTE_FRAMES;
}

// Latest report data and extra data transactions kept per module.
const REPORTS_PER_MODULE = 40;

export type ExtraDataItem = {
  index: number;
  type: number;
  moduleId: number;
  operators: Array<{ operatorId: string; value: string }>;
};

export type ParsedOracleReport = {
  phase: ReportPhase;
  module: OracleModule;
  blockNumber: number;
  transactionHash: string;
  // The committee member for a hash vote, the submitter for the other phases.
  sender: string;
  // The HashConsensus contract for a hash vote, the oracle contract otherwise.
  receiver: string;
  timestamp: number;
  refSlot: number;
  contractVersion?: string;
  fields: ReportField[];
  veboOperators?: VeboOperatorSummary[];
  rawJson: string;
};

export type RpcTransaction = {
  hash: string;
  from: string;
  to: string;
  input: string;
  blockNumber: string;
};

// A transaction as returned by eth_getTransactionByHash: contract creations
// have no recipient.
export type RawTransaction = Omit<RpcTransaction, "to"> & { to: string | null };

// A log as returned by eth_getLogs. Recent clients add the block timestamp.
export type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockTimestamp?: string;
  transactionHash: string;
};

// Values of the ExtraDataSubmitted event: the items processed so far for the
// report and the items the report declared.
export type ExtraDataProgress = {
  refSlot: number;
  itemsProcessed: number;
  itemsCount: number;
};

// A transaction that may carry a report. `extraData` is set when the
// transaction was found through an ExtraDataSubmitted event (phase 3).
export type ReportCandidate = {
  hash: string;
  module: OracleModule;
  address: string;
  extraData?: ExtraDataProgress;
};

// A member vote for a report hash (phase 1), read from a ReportReceived
// event. `consensus` is the hash that reached the quorum for the same slot.
export type HashVote = {
  module: OracleModule;
  address: string;
  member: string;
  refSlot: number;
  report: string;
  transactionHash: string;
  blockNumber: string;
  consensus?: { report: string; support: number };
};

// Execution Delegation Framework (LIP-37) DelegationContract entrypoint. Under
// EDF the oracle member is the DelegationContract and the operator's hot key
// calls the receiver through it.
const DELEGATION_CONTRACT = new Interface([
  "function execute(address target,bytes data) payable returns (bytes result)",
]);

const ACCOUNTING_V4 = new Interface([
  "function submitReportData((uint256 consensusVersion,uint256 refSlot,uint256 numValidators,uint256 clBalanceGwei,uint256[] stakingModuleIdsWithNewlyExitedValidators,uint256[] numExitedValidatorsByStakingModule,uint256 withdrawalVaultBalance,uint256 elRewardsVaultBalance,uint256 sharesRequestedToBurn,uint256[] withdrawalFinalizationBatches,uint256 simulatedShareRate,bool isBunkerMode,bytes32 vaultsDataTreeRoot,string vaultsDataTreeCid,uint256 extraDataFormat,bytes32 extraDataHash,uint256 extraDataItemsCount) data,uint256 contractVersion)",
]);

const ACCOUNTING_SR3 = new Interface([
  "function submitReportData((uint256 consensusVersion,uint256 refSlot,uint256 clValidatorsBalanceGwei,uint256 clPendingBalanceGwei,uint256[] stakingModuleIdsWithNewlyExitedValidators,uint256[] numExitedValidatorsByStakingModule,uint256[] stakingModuleIdsWithUpdatedBalance,uint256[] validatorBalancesGweiByStakingModule,uint256 withdrawalVaultBalance,uint256 elRewardsVaultBalance,uint256 sharesRequestedToBurn,uint256[] withdrawalFinalizationBatches,uint256 simulatedShareRate,bool isBunkerMode,bytes32 vaultsDataTreeRoot,string vaultsDataTreeCid,uint256 extraDataFormat,bytes32 extraDataHash,uint256 extraDataItemsCount) data,uint256 contractVersion)",
]);

const ACCOUNTING_V3 = new Interface([
  "function submitReportData((uint256 consensusVersion,uint256 refSlot,uint256 numValidators,uint256 clBalanceGwei,uint256[] stakingModuleIdsWithNewlyExitedValidators,uint256[] numExitedValidatorsByStakingModule,uint256 withdrawalVaultBalance,uint256 elRewardsVaultBalance,uint256 sharesRequestedToBurn,uint256[] withdrawalFinalizationBatches,uint256 simulatedShareRate,bool isBunkerMode,uint256 extraDataFormat,bytes32 extraDataHash,uint256 extraDataItemsCount) data,uint256 contractVersion)",
]);

const VEBO = new Interface([
  "function submitReportData((uint256 consensusVersion,uint256 refSlot,uint256 requestsCount,uint256 dataFormat,bytes data) data,uint256 contractVersion)",
]);

const FEE_V3 = new Interface([
  "function submitReportData((uint256 consensusVersion,uint256 refSlot,bytes32 treeRoot,string treeCid,string logCid,uint256 distributed,uint256 rebate,bytes32 strikesTreeRoot,string strikesTreeCid) data,uint256 contractVersion)",
]);

const FEE_V2 = new Interface([
  "function submitReportData((uint256 consensusVersion,uint256 refSlot,bytes32 treeRoot,string treeCid,string logCid,uint256 distributed) data,uint256 contractVersion)",
]);

const ACCOUNTING_EXTRA_DATA = new Interface([
  "function submitReportExtraDataEmpty()",
  "function submitReportExtraDataList(bytes data)",
]);

// Events that mark the report phases: ReportReceived, ConsensusReached and
// ConsensusLost come from HashConsensus, ProcessingStarted is emitted by a
// receiver on submitReportData and ExtraDataSubmitted by the Accounting
// Oracle on every extra data transaction.
const REPORT_EVENTS = new Interface([
  "event ReportReceived(uint256 indexed refSlot, address indexed member, bytes32 report)",
  "event ConsensusReached(uint256 indexed refSlot, bytes32 report, uint256 support)",
  "event ConsensusLost(uint256 indexed refSlot)",
  "event ProcessingStarted(uint256 indexed refSlot, bytes32 hash)",
  "event ExtraDataSubmitted(uint256 indexed refSlot, uint256 itemsProcessed, uint256 itemsCount)",
]);

export const REPORT_EVENT_TOPICS: readonly string[] = REPORT_EVENTS.fragments
  .filter((fragment) => fragment.type === "event")
  .map((fragment) => (fragment as EventFragment).topicHash);

const ZERO_HASH = `0x${"0".repeat(64)}`;

function compactNumber(value: bigint) {
  return new Intl.NumberFormat("en-US").format(value);
}

function tokenAmount(value: bigint, decimals: number, suffix: string) {
  const numeric = Number(formatUnits(value, decimals));
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 3,
  }).format(numeric)} ${suffix}`;
}

function asStrings(values: readonly bigint[]) {
  return values.map((value) => value.toString());
}

function decodeVeboRequests(
  data: string,
  dataFormat: bigint,
): VeboOperatorSummary[] {
  const bytes = data.startsWith("0x") ? data.slice(2) : data;
  const recordHexLength = dataFormat === 2n ? 144 : dataFormat === 1n ? 128 : 0;
  if (!bytes || !recordHexLength || bytes.length % recordHexLength !== 0) {
    return [];
  }

  const operators = new Map<string, VeboOperatorSummary>();
  for (let offset = 0; offset < bytes.length; offset += recordHexLength) {
    const request = bytes.slice(offset, offset + recordHexLength);
    const moduleId = Number.parseInt(request.slice(0, 6), 16);
    const operatorId = BigInt(`0x${request.slice(6, 16)}`).toString();
    const validatorIndex = BigInt(`0x${request.slice(16, 32)}`).toString();
    const hasKeyIndex = dataFormat === 2n;
    const keyIndex = hasKeyIndex
      ? BigInt(`0x${request.slice(32, 48)}`).toString()
      : null;
    const pubkey = `0x${request.slice(hasKeyIndex ? 48 : 32)}`;
    const key = `${moduleId}:${operatorId}`;
    const summary = operators.get(key) ?? {
      moduleId,
      operatorId,
      validatorCount: 0,
      nominalEth: 0,
      validatorIndices: [],
      keyIndices: [],
      pubkeys: [],
    };
    summary.validatorCount += 1;
    summary.nominalEth += 32;
    summary.validatorIndices.push(validatorIndex);
    if (keyIndex !== null) summary.keyIndices.push(keyIndex);
    summary.pubkeys.push(pubkey);
    operators.set(key, summary);
  }
  return [...operators.values()];
}

function refSlotField(refSlot: bigint): ReportField {
  return {
    label: "Reference slot",
    value: compactNumber(refSlot),
    description: "Finalized beacon-chain slot whose state this report describes.",
  };
}

function commonFields(
  consensusVersion: bigint,
  refSlot: bigint,
  contractVersion: bigint,
): ReportField[] {
  return [
    {
      label: "Consensus version",
      value: consensusVersion.toString(),
      description: "Version of the oracle committee consensus rules.",
    },
    refSlotField(refSlot),
    {
      label: "Contract version",
      value: contractVersion.toString(),
      description: "Receiver implementation version expected by the submitting oracle.",
    },
  ];
}

function parseAccounting(
  tx: RpcTransaction,
  timestamp: number,
): ParsedOracleReport | null {
  const parsed =
    ACCOUNTING_SR3.parseTransaction({ data: tx.input }) ??
    ACCOUNTING_V4.parseTransaction({ data: tx.input }) ??
    ACCOUNTING_V3.parseTransaction({ data: tx.input });
  if (!parsed) return null;

  const data = parsed.args[0];
  const contractVersion = parsed.args[1] as bigint;
  const isSr3 = data.length === 19;
  const hasVaultsData = isSr3 || data.length === 17;
  const fields = commonFields(data.consensusVersion, data.refSlot, contractVersion);
  const moduleExitCounts = (data.stakingModuleIdsWithNewlyExitedValidators as bigint[])
    .map(
      (moduleId, index) =>
        `Module ${moduleId}: ${(data.numExitedValidatorsByStakingModule[index] as bigint).toString()}`,
    )
    .join(", ");

  if (isSr3) {
    const moduleBalances = (data.stakingModuleIdsWithUpdatedBalance as bigint[])
      .map(
        (moduleId, index) =>
          `Module ${moduleId}: ${tokenAmount(
            data.validatorBalancesGweiByStakingModule[index] as bigint,
            9,
            "ETH",
          )}`,
      )
      .join(", ");
    fields.push(
      {
        label: "CL validator balance",
        value: tokenAmount(data.clValidatorsBalanceGwei, 9, "ETH"),
        description:
          "Consensus-layer validator balances, excluding pending deposits.",
      },
      {
        label: "CL pending balance",
        value: tokenAmount(data.clPendingBalanceGwei, 9, "ETH"),
        description: "Deposits still pending activation on the consensus layer.",
      },
      {
        label: "Module validator balances",
        value: moduleBalances || "No module balance updates",
        description:
          "Consensus-layer validator balance attributed to each reported staking module.",
      },
    );
  } else {
    fields.push(
      {
        label: "Lido validators",
        value: compactNumber(data.numValidators),
        description:
          "Validators ever deposited through Lido at the reference slot.",
      },
      {
        label: "Consensus-layer balance",
        value: tokenAmount(data.clBalanceGwei, 9, "ETH"),
        description: "Combined beacon-chain balance of all Lido validators.",
      },
    );
  }

  fields.push(
    {
      label: "New exited totals",
      value: moduleExitCounts || "No module updates",
      description: "Cumulative exited-validator counts updated for staking modules.",
    },
    {
      label: "Withdrawal vault",
      value: tokenAmount(data.withdrawalVaultBalance, 18, "ETH"),
      description: "Execution-layer ETH held in the withdrawal vault.",
    },
    {
      label: "EL rewards vault",
      value: tokenAmount(data.elRewardsVaultBalance, 18, "ETH"),
      description: "Execution-layer rewards available to the protocol.",
    },
    {
      label: "Shares requested to burn",
      value: tokenAmount(data.sharesRequestedToBurn, 18, "shares"),
      description: "Cover and non-cover stETH shares queued in Burner.",
    },
    {
      label: "Finalization batches",
      value:
        asStrings(data.withdrawalFinalizationBatches).join(", ") ||
        "No withdrawal batches",
      description: "Withdrawal queue request IDs selected for finalization.",
    },
    {
      label: "Simulated share rate",
      value: formatUnits(data.simulatedShareRate, 27),
      description: "Expected post-report ETH value per stETH share, at 1e27 precision.",
    },
    {
      label: "Bunker mode",
      value: data.isBunkerMode ? "Enabled" : "Disabled",
      description: "Whether withdrawal finalization uses bunker-mode safeguards.",
    },
  );

  if (hasVaultsData) {
    fields.push(
      {
        label: "Vaults data root",
        value: data.vaultsDataTreeRoot,
        description: "Merkle root of the liquid staking vaults report.",
        mono: true,
      },
      {
        label: "Vaults data CID",
        value: data.vaultsDataTreeCid || "Not supplied",
        description: "Content identifier for the published vaults data tree.",
        mono: true,
      },
    );
  }

  fields.push(
    {
      label: "Extra data format",
      value: data.extraDataFormat.toString(),
      description: "0 means empty; 1 means a chained list of operator-level updates.",
    },
    {
      label: "Extra data items",
      value: compactNumber(data.extraDataItemsCount),
      description: "Operator-level exited-validator records attached to the report.",
    },
    {
      label: "Extra data hash",
      value: data.extraDataHash,
      description: "Integrity hash for the separately submitted extra-data payload.",
      mono: true,
    },
  );

  return {
    phase: "data",
    module: "ao",
    blockNumber: Number.parseInt(tx.blockNumber, 16),
    transactionHash: tx.hash,
    sender: tx.from.toLowerCase(),
    receiver: tx.to,
    timestamp,
    refSlot: Number(data.refSlot),
    contractVersion: contractVersion.toString(),
    fields,
    rawJson: JSON.stringify(
      Object.fromEntries(fields.map((field) => [field.label, field.value])),
      null,
      2,
    ),
  };
}

function parseVebo(
  tx: RpcTransaction,
  timestamp: number,
): ParsedOracleReport | null {
  const parsed = VEBO.parseTransaction({ data: tx.input });
  if (!parsed) return null;
  const data = parsed.args[0];
  const contractVersion = parsed.args[1] as bigint;
  const operators = decodeVeboRequests(data.data, data.dataFormat);
  const decodedCount = operators.reduce(
    (total, operator) => total + operator.validatorCount,
    0,
  );
  const fields = [
    ...commonFields(data.consensusVersion, data.refSlot, contractVersion),
    {
      label: "Exit request demand",
      value: `${compactNumber(data.requestsCount)} validators`,
      description: "Total validator exits requested by this consensus report.",
    },
    {
      label: "Nominal exit demand",
      value: `${decodedCount * 32} ETH`,
      description:
        "Validator count multiplied by 32 ETH. The calldata contains validators, not their live balances.",
    },
    {
      label: "Affected operators",
      value: compactNumber(BigInt(operators.length)),
      description: "Distinct staking-module and node-operator pairs in the packed list.",
    },
    {
      label: "Data format",
      value: data.dataFormat.toString(),
      description:
        data.dataFormat === 2n
          ? "Format 2 uses 72-byte records and includes each validator's signing-key index."
          : "Format 1 uses canonical 64-byte validator exit records.",
    },
    {
      label: "Decoded validators",
      value: compactNumber(BigInt(decodedCount)),
      description: `${data.dataFormat === 2n ? "72" : "64"}-byte exit records successfully decoded from calldata.`,
    },
  ];

  return {
    phase: "data",
    module: "vebo",
    blockNumber: Number.parseInt(tx.blockNumber, 16),
    transactionHash: tx.hash,
    sender: tx.from.toLowerCase(),
    receiver: tx.to,
    timestamp,
    refSlot: Number(data.refSlot),
    contractVersion: contractVersion.toString(),
    fields,
    veboOperators: operators,
    rawJson: JSON.stringify(
      {
        fields: Object.fromEntries(fields.map((field) => [field.label, field.value])),
        operators,
      },
      null,
      2,
    ),
  };
}

function parseFee(
  module: Exclude<OracleModule, "ao" | "vebo">,
  tx: RpcTransaction,
  timestamp: number,
): ParsedOracleReport | null {
  const parsed =
    FEE_V3.parseTransaction({ data: tx.input }) ??
    FEE_V2.parseTransaction({ data: tx.input });
  if (!parsed) return null;
  const data = parsed.args[0];
  const contractVersion = parsed.args[1] as bigint;
  const isV3 = data.length === 9;
  const fields = [
    ...commonFields(data.consensusVersion, data.refSlot, contractVersion),
    {
      label: "Distribution tree root",
      value: data.treeRoot,
      description: "Merkle root used by operators to prove their fee allocations.",
      mono: true,
    },
    {
      label: "Distribution tree CID",
      value: data.treeCid || "Not supplied",
      description: "IPFS content identifier for the full distribution tree.",
      mono: true,
    },
    {
      label: "Frame log CID",
      value: data.logCid || "Not supplied",
      description: "IPFS content identifier for the calculation log of this frame.",
      mono: true,
    },
    {
      label: "Distributed fees",
      value: tokenAmount(data.distributed, 18, "shares"),
      description: "Total fee-distribution shares accounted for by this report.",
    },
  ] satisfies ReportField[];

  if (isV3) {
    fields.push(
      {
        label: "Rebate",
        value: tokenAmount(data.rebate, 18, "shares"),
        description: "Rebate shares included in this frame.",
      },
      {
        label: "Strikes tree root",
        value: data.strikesTreeRoot,
        description: "Merkle root of validator strike information.",
        mono: true,
      },
      {
        label: "Strikes tree CID",
        value: data.strikesTreeCid || "Not supplied",
        description: "IPFS content identifier for the published strikes tree.",
        mono: true,
      },
    );
  }

  return {
    phase: "data",
    module,
    blockNumber: Number.parseInt(tx.blockNumber, 16),
    transactionHash: tx.hash,
    sender: tx.from.toLowerCase(),
    receiver: tx.to,
    timestamp,
    refSlot: Number(data.refSlot),
    contractVersion: contractVersion.toString(),
    fields,
    rawJson: JSON.stringify(
      Object.fromEntries(fields.map((field) => [field.label, field.value])),
      null,
      2,
    ),
  };
}

export function parseOracleReport(
  module: OracleModule,
  transaction: RpcTransaction,
  timestamp: number,
) {
  try {
    if (module === "ao") return parseAccounting(transaction, timestamp);
    if (module === "vebo") return parseVebo(transaction, timestamp);
    return parseFee(module, transaction, timestamp);
  } catch {
    return null;
  }
}

// Split report logs by phase. The logs must be in chain order. Report data
// and extra data transactions are returned as candidates to fetch and decode;
// a hash vote is complete in its log. Only the latest `hashVoteFrames`
// reference slots of each module keep their votes.
export function collectReportLogs(
  logs: readonly RpcLog[],
  receivers: Partial<Record<OracleModule, string>>,
  consensus: Partial<Record<OracleModule, string>>,
  hashVoteFrames: number,
): { candidates: ReportCandidate[]; hashVotes: HashVote[] } {
  const modulesByAddress = (contracts: Partial<Record<OracleModule, string>>) =>
    new Map(
      (Object.entries(contracts) as Array<[OracleModule, string]>).map(
        ([module, address]) => [address.toLowerCase(), module],
      ),
    );
  const receiverModules = modulesByAddress(receivers);
  const consensusModules = modulesByAddress(consensus);

  const reportData = new Map<OracleModule, ReportCandidate[]>();
  const extraData = new Map<OracleModule, ReportCandidate[]>();
  const votes = new Map<OracleModule, HashVote[]>();
  const consensusBySlot = new Map<string, HashVote["consensus"]>();
  const push = <T>(target: Map<OracleModule, T[]>, module: OracleModule, item: T) => {
    const items = target.get(module);
    if (items) items.push(item);
    else target.set(module, [item]);
  };

  for (const log of logs) {
    let event;
    try {
      event = REPORT_EVENTS.parseLog(log);
    } catch {
      continue;
    }
    if (!event) continue;
    const address = log.address.toLowerCase();
    const hash = log.transactionHash.toLowerCase();
    const refSlot = Number(event.args.refSlot);
    const receiverModule = receiverModules.get(address);
    const consensusModule = consensusModules.get(address);

    if (receiverModule && event.name === "ProcessingStarted") {
      push(reportData, receiverModule, { hash, module: receiverModule, address });
    } else if (receiverModule && event.name === "ExtraDataSubmitted") {
      push(extraData, receiverModule, {
        hash,
        module: receiverModule,
        address,
        extraData: {
          refSlot,
          itemsProcessed: Number(event.args.itemsProcessed),
          itemsCount: Number(event.args.itemsCount),
        },
      });
    } else if (consensusModule && event.name === "ReportReceived") {
      push(votes, consensusModule, {
        module: consensusModule,
        address,
        member: (event.args.member as string).toLowerCase(),
        refSlot,
        report: event.args.report as string,
        transactionHash: hash,
        blockNumber: log.blockNumber,
      });
    } else if (consensusModule && event.name === "ConsensusReached") {
      consensusBySlot.set(`${consensusModule}:${refSlot}`, {
        report: event.args.report as string,
        support: Number(event.args.support),
      });
    } else if (consensusModule && event.name === "ConsensusLost") {
      consensusBySlot.delete(`${consensusModule}:${refSlot}`);
    }
  }

  const candidates = [...reportData.values(), ...extraData.values()].flatMap(
    (moduleCandidates) => moduleCandidates.slice(-REPORTS_PER_MODULE),
  );
  const hashVotes = [...votes.entries()].flatMap(([module, moduleVotes]) => {
    const latestSlots = new Set(
      [...new Set(moduleVotes.map((vote) => vote.refSlot))]
        .sort((a, b) => a - b)
        .slice(-hashVoteFrames),
    );
    return moduleVotes
      .filter((vote) => latestSlots.has(vote.refSlot))
      .map((vote) => ({
        ...vote,
        consensus: consensusBySlot.get(`${module}:${vote.refSlot}`),
      }));
  });
  return { candidates, hashVotes };
}

export function parseHashVote(
  vote: HashVote,
  timestamp: number,
): ParsedOracleReport {
  const fields: ReportField[] = [
    refSlotField(BigInt(vote.refSlot)),
    {
      label: "Report hash",
      value: vote.report,
      description: "Hash of the report data this member voted for.",
      mono: true,
    },
    {
      label: "Consensus hash",
      value: vote.consensus?.report ?? "Not reached",
      description: "Hash that reached the quorum for this reference slot.",
      mono: true,
    },
    {
      label: "Vote",
      value: !vote.consensus
        ? "Consensus not reached"
        : vote.consensus.report.toLowerCase() === vote.report.toLowerCase()
          ? "Matches consensus"
          : "Differs from consensus",
      description: "Whether this member voted for the hash that reached the quorum.",
    },
  ];
  if (vote.consensus) {
    fields.push({
      label: "Consensus support",
      value: `${vote.consensus.support} members`,
      description: "Members that supported the hash when the quorum was reached.",
    });
  }

  return {
    phase: "hash",
    module: vote.module,
    blockNumber: Number.parseInt(vote.blockNumber, 16),
    transactionHash: vote.transactionHash,
    sender: vote.member,
    receiver: vote.address,
    timestamp,
    refSlot: vote.refSlot,
    fields,
    rawJson: JSON.stringify(
      Object.fromEntries(fields.map((field) => [field.label, field.value])),
      null,
      2,
    ),
  };
}

// Extra data item sizes in hex characters (see ExtraDataService in
// lido-oracle). A chunk is the hash of the next chunk followed by items:
// | 3 bytes itemIndex | 2 bytes itemType | 3 bytes moduleId |
// | 8 bytes nodeOpsCount | 8 bytes per operator id | 16 bytes per value |
const EXTRA_DATA_HASH = 64;
const EXTRA_DATA_ITEM_HEADER = 32;
const EXTRA_DATA_OPERATOR_ID = 16;
const EXTRA_DATA_VALUE = 32;

export function decodeExtraDataList(
  data: string,
): { nextHash: string; items: ExtraDataItem[] } | null {
  const bytes = data.startsWith("0x") ? data.slice(2) : data;
  if (bytes.length < EXTRA_DATA_HASH) return null;

  const items: ExtraDataItem[] = [];
  let offset = EXTRA_DATA_HASH;
  while (offset < bytes.length) {
    if (bytes.length - offset < EXTRA_DATA_ITEM_HEADER) return null;
    const count = BigInt(`0x${bytes.slice(offset + 16, offset + 32)}`);
    const idsStart = offset + EXTRA_DATA_ITEM_HEADER;
    if (
      count * BigInt(EXTRA_DATA_OPERATOR_ID + EXTRA_DATA_VALUE) >
      BigInt(bytes.length - idsStart)
    ) {
      return null;
    }
    const valuesStart = idsStart + Number(count) * EXTRA_DATA_OPERATOR_ID;
    items.push({
      index: Number.parseInt(bytes.slice(offset, offset + 6), 16),
      type: Number.parseInt(bytes.slice(offset + 6, offset + 10), 16),
      moduleId: Number.parseInt(bytes.slice(offset + 10, offset + 16), 16),
      operators: Array.from({ length: Number(count) }, (_, index) => {
        const id = idsStart + index * EXTRA_DATA_OPERATOR_ID;
        const value = valuesStart + index * EXTRA_DATA_VALUE;
        return {
          operatorId: BigInt(
            `0x${bytes.slice(id, id + EXTRA_DATA_OPERATOR_ID)}`,
          ).toString(),
          value: BigInt(
            `0x${bytes.slice(value, value + EXTRA_DATA_VALUE)}`,
          ).toString(),
        };
      }),
    });
    offset = valuesStart + Number(count) * EXTRA_DATA_VALUE;
  }
  return { nextHash: `0x${bytes.slice(0, EXTRA_DATA_HASH)}`, items };
}

// Item types of the extra data list. Stuck validators are no longer sent
// but can still appear in old reports.
const EXTRA_DATA_ITEM_TYPES: Record<number, string> = {
  1: "Stuck validators",
  2: "Exited validators",
};

// Decode an extra data transaction of the Accounting Oracle (phase 3). The
// reference slot and the progress are not in the calldata, they come from
// the ExtraDataSubmitted event of the same transaction.
export function parseExtraDataReport(
  tx: RpcTransaction,
  timestamp: number,
  progress: ExtraDataProgress,
): ParsedOracleReport | null {
  let parsed;
  try {
    parsed = ACCOUNTING_EXTRA_DATA.parseTransaction({ data: tx.input });
  } catch {
    return null;
  }
  if (!parsed) return null;

  const isList = parsed.name === "submitReportExtraDataList";
  const list = isList ? decodeExtraDataList(parsed.args[0] as string) : null;
  const fields: ReportField[] = [
    refSlotField(BigInt(progress.refSlot)),
    {
      label: "Extra data format",
      value: isList ? "1 (list)" : "0 (empty)",
      description: "0 means empty; 1 means a chained list of operator-level updates.",
    },
    {
      label: "Items processed",
      value: `${progress.itemsProcessed} of ${progress.itemsCount}`,
      description: "Extra-data items of this report processed after this transaction.",
    },
  ];

  if (list) {
    fields.push(
      {
        label: "Items in this transaction",
        value: list.items.length.toString(),
        description: "Extra-data items carried by this chunk of the list.",
      },
      {
        label: "Next chunk hash",
        value: list.nextHash === ZERO_HASH ? "None, this is the last chunk" : list.nextHash,
        description: "Hash of the next transaction in the extra-data chain.",
        mono: true,
      },
    );
    // One module can be split into several items, so group them by label.
    const valuesByLabel = new Map<string, string[]>();
    for (const item of list.items) {
      const label = `${EXTRA_DATA_ITEM_TYPES[item.type] ?? `Item type ${item.type}`} · module ${item.moduleId}`;
      valuesByLabel.set(label, [
        ...(valuesByLabel.get(label) ?? []),
        ...item.operators.map(
          (operator) => `Operator ${operator.operatorId}: ${operator.value}`,
        ),
      ]);
    }
    for (const [label, values] of valuesByLabel) {
      fields.push({
        label,
        value: values.join(", "),
        description: "Cumulative validator count reported for each node operator.",
      });
    }
  } else if (isList) {
    fields.push({
      label: "Extra data items",
      value: "Could not be decoded",
      description: "The chunk does not follow the known extra-data list layout.",
    });
  }

  return {
    phase: "extra",
    module: "ao",
    blockNumber: Number.parseInt(tx.blockNumber, 16),
    transactionHash: tx.hash,
    sender: tx.from.toLowerCase(),
    receiver: tx.to,
    timestamp,
    refSlot: progress.refSlot,
    fields,
    rawJson: JSON.stringify(
      {
        fields: Object.fromEntries(fields.map((field) => [field.label, field.value])),
        items: list?.items ?? [],
      },
      null,
      2,
    ),
  };
}

// Resolve the report call behind a transaction: submitReportData or an extra
// data submission. The call is either sent to the receiver directly (pre-EDF
// members) or wrapped into a DelegationContract execute(target, data) call
// (EDF members).
export function unwrapReportTransaction(
  transaction: RawTransaction,
  candidate: ReportCandidate,
): { transaction: RpcTransaction; module: OracleModule } | null {
  if (!transaction.to) return null;
  if (transaction.to.toLowerCase() === candidate.address.toLowerCase()) {
    return {
      transaction: { ...transaction, to: transaction.to },
      module: candidate.module,
    };
  }

  try {
    const execution = DELEGATION_CONTRACT.parseTransaction({
      data: transaction.input,
    });
    if (!execution || execution.name !== "execute") return null;
    const target = (execution.args[0] as string).toLowerCase();
    const data = execution.args[1] as string;
    if (target !== candidate.address.toLowerCase()) return null;

    // The receiver observes the delegation contract as msg.sender. Use that
    // stable identity for attribution; the top-level sender is its rotatable
    // hot delegate and is tracked separately in the membership view.
    return {
      transaction: {
        ...transaction,
        from: transaction.to.toLowerCase(),
        to: target,
        input: data,
      },
      module: candidate.module,
    };
  } catch {
    return null;
  }
}
