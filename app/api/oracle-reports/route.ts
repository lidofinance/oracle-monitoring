import { NextRequest, NextResponse } from "next/server";
import { Interface } from "ethers";

import { CONSENSUS_CONTRACTS } from "../../consensus-contracts";
import {
  type OracleModule,
  type ParsedOracleReport,
  type RawTransaction,
  type ReportCandidate,
  type RpcLog,
  REPORT_EVENT_TOPICS,
  collectReportLogs,
  parseExtraDataReport,
  parseHashVote,
  parseOracleReport,
  safeHashVoteFrames,
  unwrapReportTransaction,
} from "../../oracle-reports";
import { HOODI_CHAIN_ID, MAINNET_CHAIN_ID, serverRpcs } from "../../rpc-config";

type NetworkKey = "mainnet" | "hoodi";

type RpcResponse<T> = {
  id: number;
  result?: T;
  error?: { message?: string };
};

// Report receivers (the oracle contracts that accept submitReportData) and
// HashConsensus contracts per network. A module missing on a network is
// simply not tracked there. RPC endpoints come from app/rpc-config.ts.
const CONFIG: Record<
  NetworkKey,
  {
    chainId: number;
    stakingRouter: string;
    contracts: Partial<Record<OracleModule, string>>;
    consensus: Partial<Record<OracleModule, string>>;
  }
> = {
  mainnet: {
    chainId: MAINNET_CHAIN_ID,
    stakingRouter: "0xFdDf38947aFB03C621C71b06C9C70bce73f12999",
    consensus: CONSENSUS_CONTRACTS.mainnet,
    contracts: {
      ao: "0x852deD011285fe67063a08005c71a85690503Cee",
      vebo: "0x0De4Ea0184c2ad0BacA7183356Aea5B8d5Bf5c6e",
      csm: "0x4D4074628678Bd302921c20573EEa1ed38DdF7FB",
      cm: "0x8EeFCdbD984c30E472BcbF545783D051CB5114e5",
    },
  },
  hoodi: {
    chainId: HOODI_CHAIN_ID,
    stakingRouter: "0xCc820558B39ee15C7C45B59390B503b83fb499A8",
    consensus: CONSENSUS_CONTRACTS.hoodi,
    contracts: {
      ao: "0xcb883B1bD0a41512b42D2dB267F2A2cd919FB216",
      vebo: "0x8664d394C2B3278F26A1B44B967aEf99707eeAB2",
      csm: "0xe7314f561B2e72f9543F1004e741bab6Fc51028B",
      csm_0x02: "0x9B8bBA11bbE1a351CC8dD1CFCa6719FF7274A208",
      cm: "0x5D2F27000C80f6f7A03015Fd49dB7FEba3fBfa83",
    },
  },
};

const STAKING_ROUTER = new Interface([
  "function getStakingModule(uint256) view returns ((uint24 id,address stakingModuleAddress,uint16 stakingModuleFee,uint16 treasuryFee,uint16 stakeShareLimit,uint8 status,string name,uint64 lastDepositAt,uint256 lastDepositBlock,uint256 exitedValidatorsCount,uint16 priorityExitShareThreshold,uint64 maxDepositsPerBlock,uint64 minDepositBlockDistance))",
]);
const LEGACY_OPERATOR = new Interface([
  "function getNodeOperator(uint256,bool) view returns (bool active,string name,address rewardAddress,uint64 totalVettedValidators,uint64 totalExitedValidators,uint64 totalAddedValidators,uint64 totalDepositedValidators)",
]);
const CURATED_MODULE = new Interface([
  "function META_REGISTRY() view returns (address)",
]);
const META_REGISTRY = new Interface([
  "function getOperatorMetadata(uint256) view returns ((string name,string description,bool ownerEditsRestricted))",
]);
const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
const ETHERSCAN_PAGE_SIZE = 40;

// Latest transactions of one address from the Etherscan API (v2). "txlist"
// lists direct calls, "txlistinternal" lists internal calls, which is how
// reports sent through EDF DelegationContracts reach the receiver.
async function etherscanHashes(
  chainId: number,
  address: string,
  action: "txlist" | "txlistinternal",
  apiKey: string,
) {
  const params = new URLSearchParams({
    chainid: String(chainId),
    module: "account",
    action,
    address,
    sort: "desc",
    page: "1",
    offset: String(ETHERSCAN_PAGE_SIZE),
    apikey: apiKey,
  });
  const response = await fetch(`${ETHERSCAN_API}?${params.toString()}`, {
    next: { revalidate: 300 },
  });
  if (!response.ok) throw new Error(`Etherscan returned ${response.status}`);
  const payload = (await response.json()) as {
    status?: string;
    message?: string;
    result?: Array<{ hash?: string }> | string;
  };
  if (!Array.isArray(payload.result)) {
    // "No transactions found" is reported as an error status with a message.
    if (payload.message?.startsWith("No transactions")) return [];
    throw new Error(
      typeof payload.result === "string"
        ? payload.result
        : (payload.message ?? "Etherscan request failed"),
    );
  }
  return [
    ...new Set(
      payload.result.flatMap((item) =>
        item.hash ? [item.hash.toLowerCase()] : [],
      ),
    ),
  ];
}

// Public endpoints cap the number of calls per JSON-RPC batch; log queries
// are the heaviest, so they get the smallest batches.
const LOG_BATCH_SIZE = 5;
const CALL_BATCH_SIZE = 40;

// Send JSON-RPC calls in batches of `chunkSize`, trying the endpoints in
// order for each batch. Per-item errors come back as null. With
// `rejectAllErrors` an endpoint that fails every item of a batch (rate
// limit, unsupported block range) is skipped instead.
async function rpcBatch<T>(
  rpcs: readonly string[],
  method: string,
  params: unknown[][],
  { rejectAllErrors = false, chunkSize = CALL_BATCH_SIZE } = {},
) {
  const results: Array<T | null> = [];
  for (let start = 0; start < params.length; start += chunkSize) {
    results.push(
      ...(await rpcBatchOnce<T>(
        rpcs,
        method,
        params.slice(start, start + chunkSize),
        rejectAllErrors,
      )),
    );
  }
  return results;
}

async function rpcBatchOnce<T>(
  rpcs: readonly string[],
  method: string,
  params: unknown[][],
  rejectAllErrors: boolean,
) {
  let lastError: unknown;
  for (const rpc of rpcs) {
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          params.map((item, index) => ({
            jsonrpc: "2.0",
            id: index + 1,
            method,
            params: item,
          })),
        ),
      });
      if (!response.ok) throw new Error(`RPC returned ${response.status}`);
      const payload = (await response.json()) as RpcResponse<T>[];
      if (!Array.isArray(payload)) throw new Error("RPC rejected batch request");
      const byId = new Map(payload.map((item) => [item.id, item]));
      if (
        rejectAllErrors &&
        payload.length &&
        payload.every((item) => item.error)
      ) {
        throw new Error(payload[0].error?.message ?? "RPC rejected batch");
      }
      return params.map((_, index) => byId.get(index + 1)?.result ?? null);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No RPC endpoint responded");
}

// Discover the report phases through events: hash votes in HashConsensus,
// ProcessingStarted the receiver emits on submitReportData and
// ExtraDataSubmitted of the Accounting Oracle. Unlike an address transaction
// list this also finds calls that arrive through EDF DelegationContracts,
// where the receiver is not the transaction recipient. Logs are returned in
// chain order, together with the number of block ranges that failed.
async function rpcReportLogs(
  rpcs: readonly string[],
  config: (typeof CONFIG)[NetworkKey],
): Promise<{ logs: RpcLog[]; failedRanges: number; ranges: number }> {
  const [latestHex] = await rpcBatch<string>(rpcs, "eth_blockNumber", [[]]);
  if (!latestHex) throw new Error("Latest block was unavailable");
  const latest = Number.parseInt(latestHex, 16);
  const fromBlock = Math.max(0, latest - 250_000);
  const ranges: unknown[][] = [];
  for (let from = fromBlock; from <= latest; from += 10_000) {
    ranges.push([
      {
        address: [
          ...Object.values(config.contracts),
          ...Object.values(config.consensus),
        ],
        topics: [REPORT_EVENT_TOPICS],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${Math.min(latest, from + 9_999).toString(16)}`,
      },
    ]);
  }
  const results = await rpcBatch<RpcLog[]>(rpcs, "eth_getLogs", ranges, {
    rejectAllErrors: true,
    chunkSize: LOG_BATCH_SIZE,
  });
  return {
    logs: results.flatMap((logs) => logs ?? []),
    failedRanges: results.filter((logs) => logs === null).length,
    ranges: ranges.length,
  };
}

// Transactions of each receiver listed by Etherscan. Used only when an API
// key is configured; it complements the event-based discovery with history
// older than the log lookback window.
async function etherscanReportCandidates(
  chainId: number,
  contracts: Partial<Record<OracleModule, string>>,
  apiKey: string,
): Promise<ReportCandidate[]> {
  const discovered = await Promise.all(
    (Object.entries(contracts) as Array<[OracleModule, string]>).flatMap(
      ([module, address]) =>
        (["txlist", "txlistinternal"] as const).map(async (action) => {
          try {
            const hashes = await etherscanHashes(chainId, address, action, apiKey);
            return hashes.map((hash) => ({ hash, module, address }));
          } catch {
            return [];
          }
        }),
    ),
  );
  return discovered.flat();
}

async function discoverReports(
  config: (typeof CONFIG)[NetworkKey],
  rpcs: readonly string[],
  hashVoteFrames: number,
) {
  const apiKey = process.env.ETHERSCAN_API_KEY?.trim();
  const [logsResult, etherscanResult] = await Promise.allSettled([
    rpcReportLogs(rpcs, config),
    apiKey
      ? etherscanReportCandidates(config.chainId, config.contracts, apiKey)
      : Promise.resolve<ReportCandidate[]>([]),
  ]);
  const { logs, failedRanges, ranges } =
    logsResult.status === "fulfilled"
      ? logsResult.value
      : { logs: [], failedRanges: 0, ranges: 0 };
  // Hash votes and extra data are found only through logs, so a failed log
  // query must be visible instead of looking like a quiet period.
  const warnings: string[] = [];
  if (logsResult.status === "rejected") {
    warnings.push(
      "Event logs could not be read: hash votes, extra data and recent report data may be missing.",
    );
  } else if (failedRanges) {
    warnings.push(
      `${failedRanges} of ${ranges} log ranges could not be read: some reports may be missing.`,
    );
  }
  const fromLogs = collectReportLogs(
    logs,
    config.contracts,
    config.consensus,
    hashVoteFrames,
  );
  // Candidates from logs go first: only they know the extra data progress.
  const candidates = [
    ...fromLogs.candidates,
    ...(etherscanResult.status === "fulfilled" ? etherscanResult.value : []),
  ];
  if (!candidates.length && !fromLogs.hashVotes.length) {
    const failure = [logsResult, etherscanResult].find(
      (result) => result.status === "rejected",
    );
    throw failure?.status === "rejected" && failure.reason instanceof Error
      ? failure.reason
      : new Error("No recent contract transactions were available");
  }
  return { logs, candidates, hashVotes: fromLogs.hashVotes, warnings };
}

async function resolveVeboOperatorNames(
  rpcs: readonly string[],
  stakingRouter: string,
  reports: ParsedOracleReport[],
) {
  const operators = new Map<
    string,
    NonNullable<ParsedOracleReport["veboOperators"]>[number][]
  >();
  for (const report of reports) {
    for (const operator of report.veboOperators ?? []) {
      const key = `${operator.moduleId}:${operator.operatorId}`;
      operators.set(key, [...(operators.get(key) ?? []), operator]);
    }
  }
  if (!operators.size) return;

  const moduleIds = [
    ...new Set(
      [...operators.keys()].map((key) => Number.parseInt(key.split(":")[0], 10)),
    ),
  ];
  const moduleResults = await rpcBatch<string>(
    rpcs,
    "eth_call",
    moduleIds.map((moduleId) => [
      {
        to: stakingRouter,
        data: STAKING_ROUTER.encodeFunctionData("getStakingModule", [moduleId]),
      },
      "latest",
    ]),
  );
  const moduleAddresses = new Map<number, string>();
  moduleResults.forEach((result, index) => {
    if (!result) return;
    try {
      const moduleState = STAKING_ROUTER.decodeFunctionResult(
        "getStakingModule",
        result,
      )[0];
      moduleAddresses.set(moduleIds[index], moduleState.stakingModuleAddress);
    } catch {
      // A missing module should not prevent the report itself from rendering.
    }
  });

  const entries = [...operators.entries()].flatMap(([key, instances]) => {
    const [moduleId, operatorId] = key.split(":");
    const moduleAddress = moduleAddresses.get(Number.parseInt(moduleId, 10));
    return moduleAddress
      ? [{ key, moduleAddress, operatorId, instances }]
      : [];
  });
  const legacyResults = await rpcBatch<string>(
    rpcs,
    "eth_call",
    entries.map(({ moduleAddress, operatorId }) => [
      {
        to: moduleAddress,
        data: LEGACY_OPERATOR.encodeFunctionData("getNodeOperator", [
          operatorId,
          true,
        ]),
      },
      "latest",
    ]),
  );

  const unresolved = entries.filter((entry, index) => {
    const result = legacyResults[index];
    if (!result) return true;
    try {
      const name = LEGACY_OPERATOR.decodeFunctionResult(
        "getNodeOperator",
        result,
      ).name as string;
      if (!name) return true;
      entry.instances.forEach((operator) => {
        operator.operatorName = name;
      });
      return false;
    } catch {
      return true;
    }
  });
  if (!unresolved.length) return;

  const registryResults = await rpcBatch<string>(
    rpcs,
    "eth_call",
    unresolved.map(({ moduleAddress }) => [
      {
        to: moduleAddress,
        data: CURATED_MODULE.encodeFunctionData("META_REGISTRY"),
      },
      "latest",
    ]),
  );
  const metadataEntries = unresolved.flatMap((entry, index) => {
    const result = registryResults[index];
    if (!result) return [];
    try {
      const registry = CURATED_MODULE.decodeFunctionResult(
        "META_REGISTRY",
        result,
      )[0] as string;
      return [{ ...entry, registry }];
    } catch {
      return [];
    }
  });
  const metadataResults = await rpcBatch<string>(
    rpcs,
    "eth_call",
    metadataEntries.map(({ registry, operatorId }) => [
      {
        to: registry,
        data: META_REGISTRY.encodeFunctionData("getOperatorMetadata", [
          operatorId,
        ]),
      },
      "latest",
    ]),
  );
  metadataResults.forEach((result, index) => {
    if (!result) return;
    try {
      const metadata = META_REGISTRY.decodeFunctionResult(
        "getOperatorMetadata",
        result,
      )[0];
      if (!metadata.name) return;
      metadataEntries[index].instances.forEach((operator) => {
        operator.operatorName = metadata.name;
      });
    } catch {
      // Some staking modules intentionally expose no operator names.
    }
  });

  for (const report of reports) {
    if (!report.veboOperators) continue;
    report.rawJson = JSON.stringify(
      {
        fields: Object.fromEntries(
          report.fields.map((field) => [field.label, field.value]),
        ),
        operators: report.veboOperators,
      },
      null,
      2,
    );
  }
}

export async function GET(request: NextRequest) {
  const network = request.nextUrl.searchParams.get("network") as NetworkKey;
  if (network !== "mainnet" && network !== "hoodi") {
    return NextResponse.json(
      { error: "network must be mainnet or hoodi" },
      { status: 400 },
    );
  }

  const config = CONFIG[network];
  const rpcs = serverRpcs(network);
  try {
    const { logs, candidates, hashVotes, warnings } = await discoverReports(
      config,
      rpcs,
      safeHashVoteFrames(request.nextUrl.searchParams.get("frames")),
    );

    // The first candidate of a transaction wins, see discoverReports.
    const candidateByHash = new Map<string, ReportCandidate>();
    for (const candidate of candidates) {
      if (!candidateByHash.has(candidate.hash)) {
        candidateByHash.set(candidate.hash, candidate);
      }
    }
    const transactions = await rpcBatch<RawTransaction>(
      rpcs,
      "eth_getTransactionByHash",
      [...candidateByHash.keys()].map((hash) => [hash]),
    );
    const reportTransactions = transactions.flatMap((transaction) => {
      if (!transaction) return [];
      const candidate = candidateByHash.get(transaction.hash.toLowerCase());
      const report = candidate
        ? unwrapReportTransaction(transaction, candidate)
        : null;
      return report && candidate
        ? [{ ...report, extraData: candidate.extraData }]
        : [];
    });

    // Logs of recent clients carry the block timestamp; the other blocks
    // are fetched.
    const timestampByBlock = new Map<string, number>();
    for (const log of logs) {
      if (log.blockTimestamp) {
        timestampByBlock.set(
          log.blockNumber,
          Number.parseInt(log.blockTimestamp, 16),
        );
      }
    }
    const blockNumbers = [
      ...new Set([
        ...reportTransactions.map(({ transaction }) => transaction.blockNumber),
        ...hashVotes.map((vote) => vote.blockNumber),
      ]),
    ].filter((block) => !timestampByBlock.has(block));
    const blocks = await rpcBatch<{ timestamp: string }>(
      rpcs,
      "eth_getBlockByNumber",
      blockNumbers.map((block) => [block, false]),
    );
    blockNumbers.forEach((block, index) => {
      timestampByBlock.set(
        block,
        blocks[index] ? Number.parseInt(blocks[index]!.timestamp, 16) : 0,
      );
    });

    const reports = [
      ...reportTransactions.map(({ transaction, module, extraData }) => {
        const timestamp = timestampByBlock.get(transaction.blockNumber) ?? 0;
        return extraData
          ? parseExtraDataReport(transaction, timestamp, extraData)
          : parseOracleReport(module, transaction, timestamp);
      }),
      ...hashVotes.map((vote) =>
        parseHashVote(vote, timestampByBlock.get(vote.blockNumber) ?? 0),
      ),
    ]
      .filter((report) => report !== null)
      .sort((a, b) => b.blockNumber - a.blockNumber);
    await resolveVeboOperatorNames(
      rpcs,
      config.stakingRouter,
      reports,
    );

    return NextResponse.json(
      {
        network,
        contracts: config.contracts,
        reports,
        warnings,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=300",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load oracle reports",
      },
      { status: 502 },
    );
  }
}
