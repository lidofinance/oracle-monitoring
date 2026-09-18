import { formatUnits, Interface } from "ethers";

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

export type ParsedOracleReport = {
  module: OracleModule;
  blockNumber: number;
  transactionHash: string;
  sender: string;
  receiver: string;
  timestamp: number;
  refSlot: number;
  contractVersion: string;
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

export type ReportCandidate = {
  hash: string;
  module: OracleModule;
  address: string;
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
    {
      label: "Reference slot",
      value: compactNumber(refSlot),
      description: "Finalized beacon-chain slot whose state this report describes.",
    },
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

// Resolve the submitReportData call behind a report transaction. The call is
// either sent to the receiver directly (pre-EDF members) or wrapped into a
// DelegationContract execute(target, data) call (EDF members).
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
