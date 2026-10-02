"use client";

import {
  AbiCoder,
  Contract,
  formatEther,
  JsonRpcProvider,
  type Log,
} from "ethers";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  FileJson,
  ListTree,
  LoaderCircle,
  Maximize2,
  Radio,
  RefreshCw,
  Search,
  ServerCog,
  X,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { CONSENSUS_CONTRACTS } from "./consensus-contracts";
import { filterWithCounts, parseSelection, toggleSelection } from "./filters";
import {
  ORACLE_MODULES,
  ORACLE_STARTUP_TOPIC,
  TELEMETRY_EVENT_KINDS,
  availableModules,
  moduleFromMessage,
  parseTelemetrySetup,
  telemetryEventFromTopic,
  type OracleModule,
  type TelemetryEvent,
} from "./oracle-modules";
import {
  DEFAULT_HASH_VOTE_FRAMES,
  HASH_VOTE_FRAMES,
  REPORT_PHASES,
  safeHashVoteFrames,
  type ParsedOracleReport,
  type ReportPhase,
} from "./oracle-reports";
import { BROWSER_RPCS, HOODI_CHAIN_ID, MAINNET_CHAIN_ID } from "./rpc-config";

type NetworkKey = "mainnet" | "hoodi";
type ViewKey = "overview" | "telemetry" | "oracle";
type ModuleKey = OracleModule;

// State of an EDF DelegationContract (LIP-37) read from the chain.
type DelegationState = {
  ownerAddress: string;
  delegateAddress: string;
  pendingDelegateAddress?: string;
  pendingActiveFrom?: number;
  cooldownSeconds?: number;
  terminated?: boolean;
};

// How an operator holds a committee seat: with its DelegationContract (after
// the EDF switch), with the contract's delegate key, or with a legacy member
// EOA that carries the same operator label (before the switch).
type SeatKind = "contract" | "delegate" | "legacy";

// An oracle operator, identified by its DelegationContract.
type Holder = {
  contract: string;
  label: string;
  state?: DelegationState;
  delegateBalanceEth?: number;
  seats: Partial<Record<ModuleKey, SeatKind>>;
  // Addresses whose telemetry belongs to this holder.
  senders: string[];
};

type Member = {
  address: string;
  balanceEth: number;
  // EDF DelegationContract state; unset for plain EOA members.
  delegateAddress?: string;
  ownerAddress?: string;
  pendingDelegateAddress?: string;
  pendingActiveFrom?: number;
  cooldownSeconds?: number;
  terminated?: boolean;
  // Key that sent this member's latest telemetry and its balance on the
  // DataBus network (Hoodi).
  telemetryAddress?: string;
  telemetryBalanceEth?: number;
  lastSlots: Partial<Record<ModuleKey, number>>;
};

type BusMessage = {
  blockNumber: number;
  transactionHash: string;
  sender: string;
  memberAddress?: string;
  holderAddress?: string;
  chainId: number | null;
  module: ModuleKey | "unknown";
  event: TelemetryEvent;
  version?: string;
  kapiVersion?: string;
  reportedDelegationContract?: string;
  raw: string;
  pretty: string;
  ageSeconds: number;
  timestamp: number;
};

type ChainConfig = {
  secondsPerSlot: number;
  genesisTime: number;
};

// Current reporting frame of a HashConsensus: a member that voted for the
// current or the previous reference slot is on time.
type FrameInfo = {
  refSlot: number;
  previousRefSlot: number;
  deadlineSlot: number;
};

type NetworkSnapshot = {
  members: Member[];
  holders: Holder[];
  frames: Partial<Record<ModuleKey, FrameInfo>>;
  blockNumber: number;
  messages: BusMessage[];
  chainConfig: ChainConfig;
  rpcUrl: string;
};

// Browser RPC endpoint chosen by the viewer per network; unset means the
// first responding default endpoint. Stored in localStorage.
type RpcChoice = Partial<Record<NetworkKey, string>>;

type Snapshot = Record<NetworkKey, NetworkSnapshot>;

type OracleReportsPayload = {
  contracts: Partial<Record<ModuleKey, string>>;
  reports: ParsedOracleReport[];
  // Set when a part of the report history could not be read.
  warnings?: string[];
};

// A transaction is listed once per phase and module.
function reportKey(report: ParsedOracleReport) {
  return `${report.phase}:${report.module}:${report.transactionHash}`;
}

// Filters kept in the URL. Telemetry has modules, event kinds, holders and a
// search query; oracle reports have modules, phases, holders and the hash
// vote depth. Holders are DelegationContract addresses. The lists are
// multi-select filters, see filters.ts.
type RouteFilters = {
  modules: ModuleKey[];
  events: TelemetryEvent[];
  telemetryHolders: string[];
  query: string;
  oracleModules: ModuleKey[];
  phases: ReportPhase[];
  holders: string[];
  frames: number;
};

const REPORT_PHASE_KEYS = REPORT_PHASES.map(({ key }) => key);
const TELEMETRY_EVENT_KEYS = TELEMETRY_EVENT_KINDS.map(({ key }) => key);

type NetworkConfig = {
  label: string;
  chainLabel: string;
  rpc: readonly string[];
  explorer: string;
  consensus: Partial<Record<ModuleKey, string>> & { ao: string };
};

const MODULES = ORACLE_MODULES;

const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  mainnet: {
    label: "Mainnet",
    chainLabel: "Ethereum",
    rpc: BROWSER_RPCS.mainnet,
    explorer: "https://etherscan.io",
    consensus: CONSENSUS_CONTRACTS.mainnet,
  },
  hoodi: {
    label: "Hoodi",
    chainLabel: "Testnet",
    rpc: BROWSER_RPCS.hoodi,
    explorer: "https://hoodi.etherscan.io",
    consensus: CONSENSUS_CONTRACTS.hoodi,
  },
};

const DATABUS = "0x37De961D6bb5865867aDd416be07189D2Dd960e6";
const DATABUS_EXPLORER = "https://hoodi.etherscan.io";
const STALE_SECONDS = 24 * 60 * 60;
// DataBus lookback in blocks (12s each): all messages for 7 days, startup
// messages for 30 days because oracles restart rarely.
const TELEMETRY_LOOKBACK_BLOCKS = 50_400;
const STARTUP_LOOKBACK_BLOCKS = 216_000;
const LOW_BALANCE_ETH = 0.4;
const VIEW_ROUTES: Record<ViewKey, string> = {
  overview: "/overview",
  telemetry: "/telemetry",
  oracle: "/reports",
};
const MEMBER_ABI = [
  "function getMembers() view returns (address[] addresses, uint256[] lastReportedRefSlots)",
  "function getChainConfig() view returns (uint256 slotsPerEpoch, uint256 secondsPerSlot, uint256 genesisTime)",
  "function getCurrentFrame() view returns (uint256 refSlot, uint256 reportProcessingDeadlineSlot)",
  "function getFrameConfig() view returns (uint256 initialEpoch, uint256 epochsPerFrame, uint256 fastLaneLengthSlots)",
];
const DELEGATION_ABI = [
  "function getDelegate() view returns (address)",
  "function owner() view returns (address)",
  "function getPendingDelegate() view returns (address delegate, uint256 activeFrom)",
  "function getCooldown() view returns (uint256)",
  "function isTerminated() view returns (bool)",
];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Operator names by oracle member address. Both the pre-EDF member EOAs and
// the EDF DelegationContracts (LIP-37) are listed for Mainnet and Hoodi, so
// the console keeps working across the switch.
const LABELS: Record<string, string> = {
  // Mainnet EDF DelegationContracts (added by vote #205)
  "0xe75a431a98487dc69a14bdd13d858e3238e9c1b3": "Instadapp",
  "0xc77d0bf3aa4778e36a89cdc8bbc9c34d8060637d": "Caliber",
  "0xc7442d4d8f3ffea0fa4a18ad3062c8137ce21749": "Staking Facilities",
  "0x56b3ea8016da18c6e8cd8135492d242f0de0dbbc":
    "Bitwise",
  "0x4e3f2deeb59eb9a205d82d17647b3e56422e0fee": "P2P",
  "0xd524101c3c40f71fce7b9312d299603880a06bdb": "Chainlayer",
  "0x99cd2ef33040879d40bbc77df81863d97f13c64d": "bloXroute",
  "0xc4f2704273598d51a0ec76a31c12553ec8f5a891": "MatrixedLink",
  "0x5e8ed9f10307ed6fa793a347e4d0f407d00b9c6f": "Stakefish",
  // Mainnet pre-EDF member EOAs
  "0x8db977c13caa938bc58464bfd622df0570564b78":
    "Bitwise",
  "0x404335bce530400a5814375e7ec1fb55faff3ea2": "Staking Facilities",
  "0x042a9e5accfa17e28300f1b5967f20891e973922": "Stakefish",
  "0x007de4a5f7bc37e2f26c0cb2e8a95006ee9b89b5": "P2P",
  "0x61c91ecd902eb56e314bb2d5c5c07785444ea1c8": "bloXroute",
  "0x73181107c8d9ed4ce0bbef7a0b4ccf3320c41d12": "Instadapp",
  "0xc79f702202e3a6b0b6310b537e786b9acaa19baf": "Chainlayer",
  "0xe57b3792adcc5da47ef4ff588883f0ee0c9835c9": "MatrixedLink",
  "0x4118dad7f348a4063bd15786c299de2f3b1333f3": "Caliber",
  // Hoodi pre-EDF member EOAs
  "0x219743f1911d84b32599bdc2df21fc8dba6f81a2": "Staking Facilities",
  "0xd3b1e36a372ca250eeff61f90e833ca070559970": "Stakefish",
  "0x99b2b75f490ffc9a29e4e1f5987be8e30e690adf": "P2P",
  "0xf7ae520e99ed3c41180b5e12681d31aa7302e4e5": "Chainlayer",
  "0x4c75fa734a39f3a21c57e583c1c29942f021c6b7": "bloXroute",
  "0xfe43a8b0b481ae9fb1862d31826532047d2d538c": "MatrixedLink",
  "0x43c45c2455c49eed320f463ff4f1ece3d2bf5ae2": "Instadapp",
  "0x1932f53b1457a5987791a40ba91f71c5efd5788f":
    "Bitwise",
  "0x948a62cc0414979dc7aa9364ba5b96ecb29f8736": "Caliber",
  "0xca80ee7313a315879f326105134f938676cfd7a9": "Lido",
  // Hoodi EDF DelegationContracts
  "0x929de74c921f3e719ad2bb026edef747d443dc8e": "Instadapp",
  "0x9f81976e461b82cfe3caec06de8efa8ad5543408": "Caliber",
  "0x9950477b8d8154ef44745612832464c3c2155f79":
    "Bitwise",
  "0xc51fe2b136a24d6ec8368c858ae5211dc2fe0e0b": "Chainlayer",
  "0x43c97fefef1e41d6429814e2a3ad37aa096d633e": "P2P",
  "0xc19a08e427351f51da7a82136af66d8f01931738": "Staking Facilities",
  "0x9d7bfaa500b5dec4fbab2257dfbc0cb3d5c1fbc8": "Stakefish",
  "0x443e31892ffd51f6f0fef6dae4ac2e2795f311bf": "bloXroute",
  "0x89e9fcb24cc82e9a449a69f3932c70ca2fa07e1d": "MatrixedLink",
  "0xafca4694c06720ad03037db3760a920320037217": "Lido",
};

// EDF DelegationContracts of the oracle operators per network. The Holders
// view starts from these contracts and reads the current delegate key from
// the chain, so key rotations need no config change. Names come from LABELS.
const HOLDER_CONTRACTS: Record<NetworkKey, readonly string[]> = {
  // Vote #205 (LIP-37)
  mainnet: [
    "0xe75a431a98487dc69a14bdd13d858e3238e9c1b3",
    "0xc77d0bf3aa4778e36a89cdc8bbc9c34d8060637d",
    "0xc7442d4d8f3ffea0fa4a18ad3062c8137ce21749",
    "0x56b3ea8016da18c6e8cd8135492d242f0de0dbbc",
    "0x4e3f2deeb59eb9a205d82d17647b3e56422e0fee",
    "0xd524101c3c40f71fce7b9312d299603880a06bdb",
    "0x99cd2ef33040879d40bbc77df81863d97f13c64d",
    "0xc4f2704273598d51a0ec76a31c12553ec8f5a891",
    "0x5e8ed9f10307ed6fa793a347e4d0f407d00b9c6f",
  ],
  // Hoodi EDF/DSM v5 upgrade vote (2026-08-26)
  hoodi: [
    "0x929de74c921f3e719ad2bb026edef747d443dc8e",
    "0x9f81976e461b82cfe3caec06de8efa8ad5543408",
    "0x9950477b8d8154ef44745612832464c3c2155f79",
    "0xc51fe2b136a24d6ec8368c858ae5211dc2fe0e0b",
    "0x43c97fefef1e41d6429814e2a3ad37aa096d633e",
    "0xc19a08e427351f51da7a82136af66d8f01931738",
    "0x9d7bfaa500b5dec4fbab2257dfbc0cb3d5c1fbc8",
    "0x443e31892ffd51f6f0fef6dae4ac2e2795f311bf",
    "0x89e9fcb24cc82e9a449a69f3932c70ca2fa07e1d",
    "0xafca4694c06720ad03037db3760a920320037217",
  ],
};

function shorten(value: string, head = 6, tail = 4) {
  return `${value.slice(0, head + 2)}…${value.slice(-tail)}`;
}

function plural(value: number, unit: string) {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function relativeTime(seconds: number) {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${plural(Math.floor(seconds / 60), "min")} ago`;
  if (seconds < 86400) return `${plural(Math.floor(seconds / 3600), "hr")} ago`;
  return `${plural(Math.floor(seconds / 86400), "day")} ago`;
}

function formatBalance(balanceEth: number) {
  if (balanceEth === 0) return "0";
  if (balanceEth < 0.0001) return "<0.0001";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: balanceEth < 1 ? 4 : 3,
  }).format(balanceEth);
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function viewFromPath(pathname: string | null): ViewKey {
  if (pathname?.startsWith("/telemetry")) return "telemetry";
  if (pathname?.startsWith("/reports")) return "oracle";
  return "overview";
}

function safeNetwork(value: string | null): NetworkKey {
  return value === "hoodi" || value === "mainnet" ? value : "mainnet";
}

function moduleKeysFor(network: NetworkKey): ModuleKey[] {
  return availableModules(NETWORKS[network].consensus).map(({ key }) => key);
}

// Holder behind a report sender. Current seats are resolved from the chain;
// a legacy EOA that already left the committee is matched by operator label.
function holderContractFor(
  network: NetworkKey,
  sender: string,
  holderByMember: Map<string, Holder>,
) {
  const label = LABELS[sender];
  return (
    holderByMember.get(sender)?.contract ??
    (label
      ? HOLDER_CONTRACTS[network].find((contract) => LABELS[contract] === label)
      : undefined)
  );
}

function safeJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function chainIdFromMessage(raw: string) {
  try {
    const value = (JSON.parse(raw) as { chain_id?: unknown }).chain_id;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value))
      return Number(value);
  } catch {
    return null;
  }
  return null;
}

function decodeBytes(data: string) {
  try {
    const [bytes] = AbiCoder.defaultAbiCoder().decode(["bytes"], data);
    const clean = bytes.slice(2);
    const chars = clean.match(/.{1,2}/g) ?? [];
    const decoded = new TextDecoder().decode(
      new Uint8Array(chars.map((byte: string) => Number.parseInt(byte, 16))),
    );
    const start = decoded.search(/[\[{]/);
    if (start < 0) return decoded.trim();
    const close = decoded[start] === "{" ? "}" : "]";
    const end = decoded.lastIndexOf(close);
    return decoded.slice(start, end > start ? end + 1 : undefined);
  } catch {
    return data;
  }
}

async function connect(rpcs: readonly string[]) {
  let lastError: unknown;
  for (const rpc of rpcs) {
    try {
      const provider = new JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      return { provider, url: rpc };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No RPC endpoint responded");
}

// The chosen endpoint is tried first; the defaults stay as a fallback so a
// broken custom URL does not take the console down.
function rpcCandidates(network: NetworkKey, choice: RpcChoice) {
  const chosen = choice[network];
  const defaults = NETWORKS[network].rpc;
  return chosen ? [chosen, ...defaults.filter((url) => url !== chosen)] : defaults;
}

const RPC_STORAGE_KEY = "oracle-watch.rpc";
const rpcChoiceListeners = new Set<() => void>();

function readRpcChoiceRaw() {
  try {
    return window.localStorage.getItem(RPC_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function parseRpcChoice(raw: string): RpcChoice {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const choice: RpcChoice = {};
    for (const network of ["mainnet", "hoodi"] as const) {
      const value = parsed[network];
      if (typeof value === "string" && /^https?:\/\//.test(value)) {
        choice[network] = value;
      }
    }
    return choice;
  } catch {
    return {};
  }
}

function writeRpcChoice(choice: RpcChoice) {
  try {
    window.localStorage.setItem(RPC_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Private mode or blocked storage: the choice lives for this page only.
  }
  rpcChoiceListeners.forEach((listener) => listener());
}

function subscribeRpcChoice(listener: () => void) {
  rpcChoiceListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    rpcChoiceListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Read the state of a DelegationContract; null when the address is not one
// (a plain EOA member, or a contract without the EDF interface).
async function readDelegation(
  provider: JsonRpcProvider,
  address: string,
): Promise<DelegationState | null> {
  try {
    const delegation = new Contract(address, DELEGATION_ABI, provider);
    // The delegate and owner identify the contract; the other fields are
    // optional so one failing call does not hide the contract.
    const [delegate, owner] = await Promise.all([
      delegation.getDelegate(),
      delegation.owner(),
    ]);
    const [pending, cooldown, terminated] = await Promise.allSettled([
      delegation.getPendingDelegate(),
      delegation.getCooldown(),
      delegation.isTerminated(),
    ]);
    const pendingDelegate =
      pending.status === "fulfilled"
        ? (pending.value[0] as string).toLowerCase()
        : ZERO_ADDRESS;
    return {
      delegateAddress: (delegate as string).toLowerCase(),
      ownerAddress: (owner as string).toLowerCase(),
      pendingDelegateAddress:
        pendingDelegate === ZERO_ADDRESS ? undefined : pendingDelegate,
      pendingActiveFrom:
        pending.status === "fulfilled" && pendingDelegate !== ZERO_ADDRESS
          ? Number(pending.value[1])
          : undefined,
      cooldownSeconds:
        cooldown.status === "fulfilled" ? Number(cooldown.value) : undefined,
      terminated:
        terminated.status === "fulfilled" ? Boolean(terminated.value) : undefined,
    };
  } catch {
    return null;
  }
}

async function readBalance(provider: JsonRpcProvider, address: string) {
  return Number(formatEther(await provider.getBalance(address)));
}

// Holders are the operators' DelegationContracts. Membership is resolved per
// module from the current HashConsensus members: the contract itself, its
// delegate key, or a legacy EOA labelled with the same operator.
async function fetchHolders(
  provider: JsonRpcProvider,
  network: NetworkKey,
  members: Member[],
): Promise<Holder[]> {
  const holders = await Promise.all(
    HOLDER_CONTRACTS[network].map(async (contract) => {
      const label = LABELS[contract] ?? shorten(contract, 6, 4);
      const state = (await readDelegation(provider, contract)) ?? undefined;
      const delegateBalanceEth = state
        ? await readBalance(provider, state.delegateAddress).catch(
            () => undefined,
          )
        : undefined;
      const legacyMembers = members.filter(
        (member) =>
          member.address !== contract &&
          member.address !== state?.delegateAddress &&
          LABELS[member.address] === label,
      );
      const seats: Holder["seats"] = {};
      for (const { key } of MODULES) {
        const holds = (address: string | undefined) =>
          address !== undefined &&
          members.some(
            (member) =>
              member.address === address && member.lastSlots[key] !== undefined,
          );
        if (holds(contract)) seats[key] = "contract";
        else if (holds(state?.delegateAddress)) seats[key] = "delegate";
        else if (
          legacyMembers.some((member) => member.lastSlots[key] !== undefined)
        )
          seats[key] = "legacy";
      }
      const senders = [
        contract,
        ...(state ? [state.delegateAddress] : []),
        ...legacyMembers.map((member) => member.address),
      ];
      return { contract, label, state, delegateBalanceEth, seats, senders };
    }),
  );
  return holders.sort((a, b) => a.label.localeCompare(b.label));
}

async function fetchMembers(
  provider: JsonRpcProvider,
  contracts: NetworkConfig["consensus"],
) {
  const moduleResults = await Promise.all(
    availableModules(contracts).map(async ({ key }) => {
      const contract = new Contract(
        contracts[key] as string,
        MEMBER_ABI,
        provider,
      );
      const [[addresses, slots], [refSlot, deadlineSlot], [, epochsPerFrame]] =
        await Promise.all([
          contract.getMembers(),
          contract.getCurrentFrame(),
          contract.getFrameConfig(),
        ]);
      return {
        key,
        values: (addresses as string[]).map((address, index) => ({
          address: address.toLowerCase(),
          slot: Number(slots[index]),
        })),
        frame: {
          refSlot: Number(refSlot),
          epochsPerFrame: Number(epochsPerFrame),
          deadlineSlot: Number(deadlineSlot),
        },
      };
    }),
  );

  const merged = new Map<string, Member>();
  for (const result of moduleResults) {
    for (const value of result.values) {
      const member = merged.get(value.address) ?? {
        address: value.address,
        balanceEth: 0,
        lastSlots: {},
      };
      member.lastSlots[result.key] = value.slot;
      merged.set(value.address, member);
    }
  }

  const members = [...merged.values()];
  const chainContract = new Contract(contracts.ao, MEMBER_ABI, provider);
  const [[slotsPerEpoch, secondsPerSlot, genesisTime], resolvedMembers] = await Promise.all([
    chainContract.getChainConfig(),
    Promise.all(
      members.map(async (member) => {
        const state = await readDelegation(provider, member.address);
        return state ? { ...member, ...state } : member;
      }),
    ),
  ]);
  const balances = await Promise.all(
    resolvedMembers.map(async (member) => ({
      address: member.address,
      balanceEth: Number(
        formatEther(
          await provider.getBalance(member.delegateAddress ?? member.address),
        ),
      ),
    })),
  );
  balances.forEach(({ address, balanceEth }) => {
    const member = merged.get(address);
    if (member) member.balanceEth = balanceEth;
  });
  resolvedMembers.forEach((resolved) => {
    const member = merged.get(resolved.address);
    if (!member) return;
    member.delegateAddress = resolved.delegateAddress;
    member.ownerAddress = resolved.ownerAddress;
    member.pendingDelegateAddress = resolved.pendingDelegateAddress;
    member.pendingActiveFrom = resolved.pendingActiveFrom;
    member.cooldownSeconds = resolved.cooldownSeconds;
    member.terminated = resolved.terminated;
  });

  return {
    members: [...merged.values()].sort((a, b) =>
      (LABELS[a.address] ?? a.address).localeCompare(
        LABELS[b.address] ?? b.address,
      ),
    ),
    chainConfig: {
      secondsPerSlot: Number(secondsPerSlot),
      genesisTime: Number(genesisTime),
    },
    frames: Object.fromEntries(
      moduleResults.map(({ key, frame }) => [
        key,
        {
          refSlot: frame.refSlot,
          previousRefSlot:
            frame.refSlot - frame.epochsPerFrame * Number(slotsPerEpoch),
          deadlineSlot: frame.deadlineSlot,
        } satisfies FrameInfo,
      ]),
    ) as Partial<Record<ModuleKey, FrameInfo>>,
  };
}

async function fetchLogRanges(
  provider: JsonRpcProvider,
  filter: { address: string; topics?: string[] },
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
) {
  const chunks: Array<{ fromBlock: number; toBlock: number }> = [];
  for (let lo = fromBlock; lo <= toBlock; lo += chunkSize) {
    chunks.push({ fromBlock: lo, toBlock: Math.min(lo + chunkSize - 1, toBlock) });
  }

  const logs: Log[] = [];
  for (let index = 0; index < chunks.length; index += 6) {
    const group = chunks.slice(index, index + 6);
    const results = await Promise.allSettled(
      group.map((range) => provider.getLogs({ ...filter, ...range })),
    );
    results.forEach((result) => {
      if (result.status === "fulfilled") logs.push(...result.value);
    });
  }
  return logs;
}

async function fetchDataBus(provider: JsonRpcProvider) {
  const latest = await provider.getBlock("latest");
  if (!latest) throw new Error("Latest Hoodi block was unavailable");
  const from = Math.max(0, latest.number - TELEMETRY_LOOKBACK_BLOCKS);
  const startupFrom = Math.max(0, latest.number - STARTUP_LOOKBACK_BLOCKS);
  const [logs, startupLogs] = await Promise.all([
    fetchLogRanges(provider, { address: DATABUS }, from, latest.number, 2_000),
    startupFrom < from
      ? fetchLogRanges(
          provider,
          { address: DATABUS, topics: [ORACLE_STARTUP_TOPIC] },
          startupFrom,
          from - 1,
          10_000,
        )
      : Promise.resolve([] as Log[]),
  ]);

  return [...logs, ...startupLogs]
    .map((log) => {
      const raw = decodeBytes(log.data);
      const sender = log.topics[1]
        ? `0x${log.topics[1].slice(-40)}`.toLowerCase()
        : "unknown";
      const ageSeconds = Math.max(0, (latest.number - log.blockNumber) * 12);
      const setup = parseTelemetrySetup(raw);
      return {
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        sender,
        chainId: chainIdFromMessage(raw),
        module: moduleFromMessage(raw, log.topics[0] ?? ""),
        event: telemetryEventFromTopic(log.topics[0] ?? ""),
        version: setup.version,
        kapiVersion: setup.kapiVersion,
        reportedDelegationContract: setup.delegationContract,
        raw,
        pretty: safeJson(raw),
        ageSeconds,
        timestamp: latest.timestamp - ageSeconds,
      } satisfies BusMessage;
    })
    .sort((a, b) => b.blockNumber - a.blockNumber);
}

async function fetchSnapshot(choice: RpcChoice): Promise<Snapshot> {
  const [mainnet, hoodi] = await Promise.all([
    connect(rpcCandidates("mainnet", choice)),
    connect(rpcCandidates("hoodi", choice)),
  ]);
  const mainnetProvider = mainnet.provider;
  const hoodiProvider = hoodi.provider;
  const [
    mainnetMembership,
    hoodiMembership,
    mainnetBlock,
    hoodiBlock,
    messages,
  ] =
    await Promise.all([
      fetchMembers(mainnetProvider, NETWORKS.mainnet.consensus),
      fetchMembers(hoodiProvider, NETWORKS.hoodi.consensus),
      mainnetProvider.getBlockNumber(),
      hoodiProvider.getBlockNumber(),
      fetchDataBus(hoodiProvider),
    ]);

  const [mainnetHolders, hoodiHolders] = await Promise.all([
    fetchHolders(mainnetProvider, "mainnet", mainnetMembership.members),
    fetchHolders(hoodiProvider, "hoodi", hoodiMembership.members),
  ]);

  // Attribute each message to the member (for the participation views) and
  // to the holder (for the Holders view) that own the sending key.
  const attachMembersToTelemetry = (
    chainId: number,
    members: Member[],
    holders: Holder[],
  ) => {
    const memberByDelegate = new Map(
      members.map((member) => [
        member.delegateAddress ?? member.address,
        member.address,
      ]),
    );
    const holderBySender = new Map(
      holders.flatMap((holder) =>
        holder.senders.map((sender) => [sender, holder.contract] as const),
      ),
    );
    return messages.flatMap((message) => {
      if (message.chainId !== chainId) return [];
      const memberAddress = memberByDelegate.get(message.sender);
      const holderAddress = holderBySender.get(message.sender);
      return memberAddress || holderAddress
        ? [{ ...message, memberAddress, holderAddress }]
        : [];
    });
  };
  const mainnetMessages = attachMembersToTelemetry(
    MAINNET_CHAIN_ID,
    mainnetMembership.members,
    mainnetHolders,
  );
  const hoodiMessages = attachMembersToTelemetry(
    HOODI_CHAIN_ID,
    hoodiMembership.members,
    hoodiHolders,
  );

  // The telemetry key lives on the DataBus network (Hoodi) for both oracle
  // networks; its balance is read there.
  const attachTelemetryBalances = async (
    members: Member[],
    attached: BusMessage[],
  ) => {
    const senderByMember = new Map<string, string>();
    for (const message of attached) {
      if (message.memberAddress && !senderByMember.has(message.memberAddress)) {
        senderByMember.set(message.memberAddress, message.sender);
      }
    }
    await Promise.all(
      members.map(async (member) => {
        const sender = senderByMember.get(member.address);
        if (!sender) return;
        member.telemetryAddress = sender;
        member.telemetryBalanceEth = await readBalance(hoodiProvider, sender).catch(
          () => undefined,
        );
      }),
    );
  };
  await Promise.all([
    attachTelemetryBalances(mainnetMembership.members, mainnetMessages),
    attachTelemetryBalances(hoodiMembership.members, hoodiMessages),
  ]);

  return {
    mainnet: {
      members: mainnetMembership.members,
      holders: mainnetHolders,
      frames: mainnetMembership.frames,
      blockNumber: mainnetBlock,
      messages: mainnetMessages,
      chainConfig: mainnetMembership.chainConfig,
      rpcUrl: mainnet.url,
    },
    hoodi: {
      members: hoodiMembership.members,
      holders: hoodiHolders,
      frames: hoodiMembership.frames,
      blockNumber: hoodiBlock,
      messages: hoodiMessages,
      chainConfig: hoodiMembership.chainConfig,
      rpcUrl: hoodi.url,
    },
  };
}

function formatDuration(seconds: number) {
  if (seconds % 86400 === 0) return plural(seconds / 86400, "day");
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "min");
  return plural(seconds, "sec");
}

type VoteState = "current" | "previous" | "missed" | "unknown";

function voteStateFor(slot: number | undefined, frame: FrameInfo | undefined): VoteState {
  if (slot === undefined || !frame) return "unknown";
  if (slot >= frame.refSlot) return "current";
  if (slot >= frame.previousRefSlot) return "previous";
  return "missed";
}

function AddressLink({
  address,
  explorer,
  head = 8,
  tail = 6,
}: {
  address: string;
  explorer: string;
  head?: number;
  tail?: number;
}) {
  return (
    <a
      className="address-link"
      href={`${explorer}/address/${address}`}
      target="_blank"
      rel="noreferrer"
      title={address}
    >
      {shorten(address, head, tail)}
      <ExternalLink size={11} />
    </a>
  );
}

function ModulePill({ module }: { module: ModuleKey | "unknown" }) {
  const label =
    MODULES.find((item) => item.key === module)?.label ?? "Unknown";
  return <span className={`module-pill module-${module}`}>{label}</span>;
}

function eventLabel(event: TelemetryEvent) {
  return TELEMETRY_EVENT_KINDS.find((item) => item.key === event)?.label ?? "Other";
}

type FilterOption<T extends string> = {
  value: T;
  label: string;
  title?: string;
};

// A toolbar button that opens a menu below it. The menu closes on a click
// outside and on Escape.
function Dropdown({
  label,
  value,
  active = false,
  children,
}: {
  label: string;
  // Short text of the current choice, shown on the button.
  value: string;
  active?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="filter-menu" ref={root}>
      <button
        type="button"
        className={`filter-menu-button${active ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {label} <strong>{value}</strong>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="filter-menu-list" role="menu" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// A multi-select filter: a menu of options with the number of items behind
// every option. The button shows what is selected.
function FilterMenu<T extends string>({
  label,
  options,
  selected,
  counts,
  onChange,
}: {
  label: string;
  options: FilterOption<T>[];
  selected: readonly T[];
  counts: Map<string, number>;
  onChange: (selected: T[]) => void;
}) {
  const values = options.map(({ value }) => value);
  const chosen = options.filter(({ value }) => selected.includes(value));
  const summary = !chosen.length
    ? "All"
    : chosen.length > 2
      ? `${chosen.length} selected`
      : chosen.map((option) => option.label).join(", ");
  return (
    <Dropdown label={label} value={summary} active={chosen.length > 0}>
      {(close) => (
        <>
          {options.map(({ value, label: text, title }) => {
            const checked = selected.includes(value);
            const count = counts.get(value) ?? 0;
            return (
              <button
                type="button"
                key={value}
                role="menuitemcheckbox"
                aria-checked={checked}
                className={count ? "" : "empty"}
                title={title}
                onClick={() => onChange(toggleSelection(selected, value, values))}
              >
                <span className="filter-menu-box">
                  {checked && <Check size={11} />}
                </span>
                {text}
                <small>{count.toLocaleString()}</small>
              </button>
            );
          })}
          <footer>
            <button
              type="button"
              disabled={!selected.length}
              onClick={() => onChange([])}
            >
              Clear
            </button>
            <button type="button" onClick={close}>
              Done
            </button>
          </footer>
        </>
      )}
    </Dropdown>
  );
}

function PhasePill({ phase }: { phase: ReportPhase }) {
  const item = REPORT_PHASES.find(({ key }) => key === phase);
  return (
    <span className={`module-pill phase-${phase}`} title={item?.full}>
      {item?.label ?? phase}
    </span>
  );
}

function BalanceChip({
  label,
  address,
  balanceEth,
  explorer,
}: {
  label: string;
  address?: string;
  balanceEth?: number;
  explorer: string;
}) {
  const low = balanceEth === undefined || balanceEth < LOW_BALANCE_ETH;
  return (
    <a
      className={`wallet-chip ${low ? "low" : "funded"}`}
      href={address ? `${explorer}/address/${address}` : undefined}
      target="_blank"
      rel="noreferrer"
      title={
        address
          ? `${label}: ${address}`
          : `${label}: no telemetry sender seen in the last 7 days`
      }
    >
      <span>{label}</span>
      <strong>
        {balanceEth === undefined ? "n/a" : `${formatBalance(balanceEth)} ETH`}
      </strong>
    </a>
  );
}

function CopyButton({
  value,
  onCopied,
  label = "Copy message",
}: {
  value: string;
  onCopied: () => void;
  label?: string;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        onCopied();
      }}
    >
      <Copy size={15} />
    </button>
  );
}

const CUSTOM_RPC = "custom";

function RpcPicker({
  network,
  choice,
  connectedUrl,
  onChange,
}: {
  network: NetworkKey;
  choice: RpcChoice;
  connectedUrl?: string;
  onChange: (url: string) => void;
}) {
  const defaults = NETWORKS[network].rpc;
  const chosen = choice[network] ?? "";
  const isCustom = chosen !== "" && !defaults.includes(chosen);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const chosenFailed =
    chosen !== "" && connectedUrl !== undefined && connectedUrl !== chosen;

  const apply = () => {
    const url = draft.trim();
    if (!/^https?:\/\//.test(url)) return;
    onChange(url);
    setEditing(false);
  };

  return (
    <div
      className={`rpc-picker ${chosenFailed ? "failed" : ""}`}
      title={
        chosenFailed
          ? `${chosen} did not respond, using ${connectedUrl}`
          : connectedUrl
            ? `Connected to ${connectedUrl}`
            : `Browser RPC for ${NETWORKS[network].label}`
      }
    >
      <span className={`pulse ${connectedUrl ? "" : "idle"}`} />
      <span className="rpc-label">RPC</span>
      <select
        aria-label={`${NETWORKS[network].label} RPC endpoint`}
        value={editing ? CUSTOM_RPC : chosen}
        onChange={(event) => {
          const value = event.target.value;
          if (value === CUSTOM_RPC) {
            setDraft(isCustom ? chosen : "");
            setEditing(true);
            return;
          }
          setEditing(false);
          onChange(value);
        }}
      >
        <option value="">
          {connectedUrl && chosen === ""
            ? `Auto · ${hostOf(connectedUrl)}`
            : "Auto"}
        </option>
        {defaults.map((url) => (
          <option key={url} value={url}>
            {hostOf(url)}
          </option>
        ))}
        {isCustom && !editing && <option value={chosen}>{hostOf(chosen)}</option>}
        <option value={CUSTOM_RPC}>Custom URL…</option>
      </select>
      {editing && (
        <form
          className="rpc-custom"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <input
            type="url"
            autoFocus
            placeholder="https://rpc.example/…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
            aria-label="Custom RPC URL"
          />
          <button type="submit">
            <Check size={14} />
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            <X size={14} />
          </button>
        </form>
      )}
    </div>
  );
}

function RouteButton({
  value,
  onCopied,
}: {
  value: string;
  onCopied: () => void;
}) {
  return (
    <button
      className="route-button"
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        onCopied();
      }}
    >
      <Copy size={15} />
      URL
    </button>
  );
}

function JsonModal({
  message,
  onClose,
  onCopied,
}: {
  message: BusMessage;
  onClose: () => void;
  onCopied: () => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="json-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Message payload"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <div className="eyebrow">DataBus payload</div>
            <h2>
              Block {message.blockNumber.toLocaleString()}{" "}
              <ModulePill module={message.module} />
            </h2>
          </div>
          <div className="modal-actions">
            <CopyButton
              value={message.pretty}
              onCopied={onCopied}
              label="Copy formatted JSON"
            />
            <button
              className="icon-button"
              type="button"
              onClick={onClose}
              aria-label="Close payload"
              title="Close"
            >
              <X size={17} />
            </button>
          </div>
        </header>
        <pre className="json-view">{message.pretty}</pre>
      </section>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spin" size={22} />
      <div>
        <strong>Reading onchain state</strong>
        <span>Members, wallet balances, and seven days of DataBus telemetry</span>
      </div>
    </div>
  );
}

function OracleReportInspector({
  report,
  explorer,
  onCopied,
}: {
  report: ParsedOracleReport;
  explorer: string;
  onCopied: () => void;
}) {
  return (
    <>
      <header className="inspector-header">
        <div>
          <div className="eyebrow">
            {REPORT_PHASES.find(({ key }) => key === report.phase)?.full ??
              "Consensus report"}
          </div>
          <h2>Block {report.blockNumber.toLocaleString()}</h2>
        </div>
        <div className="inspector-actions">
          <CopyButton
            value={report.rawJson}
            onCopied={onCopied}
            label="Copy decoded report"
          />
          <a
            className="icon-button"
            href={`${explorer}/tx/${report.transactionHash}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Open transaction"
            title="Open transaction"
          >
            <ExternalLink size={15} />
          </a>
        </div>
      </header>

      <div className="report-metadata">
        <div>
          <span>Module</span>
          <ModulePill module={report.module} />
        </div>
        <div>
          <span>{report.phase === "hash" ? "Voted by" : "Submitted by"}</span>
          <strong>{LABELS[report.sender] ?? shorten(report.sender, 7, 5)}</strong>
        </div>
        <div>
          <span>Observed</span>
          <strong>{formatTime(report.timestamp)}</strong>
        </div>
        <div>
          <span>{report.phase === "hash" ? "HashConsensus" : "Receiver"}</span>
          <a
            href={`${explorer}/address/${report.receiver}`}
            target="_blank"
            rel="noreferrer"
          >
            {shorten(report.receiver, 8, 6)}
            <ExternalLink size={12} />
          </a>
        </div>
      </div>

      <div className="decoded-fields">
        {report.fields.map((field) => (
          <div className="decoded-field" key={field.label}>
            <span>{field.label}</span>
            <strong className={field.mono ? "mono" : ""}>{field.value}</strong>
            <p>{field.description}</p>
          </div>
        ))}
      </div>

      {report.veboOperators && (
        <section className="vebo-breakdown">
          <header>
            <div>
              <h3>Exit demand by operator</h3>
              <p>
                Nominal ETH uses 32 ETH per validator; calldata does not include
                live validator balances.
              </p>
            </div>
            <strong>
              {report.veboOperators.reduce(
                (total, operator) => total + operator.nominalEth,
                0,
              )}{" "}
              ETH
            </strong>
          </header>
          <div className="vebo-table-scroll">
            <table className="vebo-table">
              <thead>
                <tr>
                  <th>Staking module</th>
                  <th>Operator</th>
                  <th>Validators</th>
                  <th>Nominal ETH</th>
                  <th>Validator indices</th>
                </tr>
              </thead>
              <tbody>
                {report.veboOperators.map((operator) => (
                  <tr key={`${operator.moduleId}-${operator.operatorId}`}>
                    <td>Module {operator.moduleId}</td>
                    <td>
                      <strong>{operator.operatorName || "Unnamed operator"}</strong>
                      <small>Operator #{operator.operatorId}</small>
                    </td>
                    <td>{operator.validatorCount}</td>
                    <td>{operator.nominalEth} ETH</td>
                    <td title={operator.validatorIndices.join(", ")}>
                      {operator.validatorIndices.slice(0, 5).join(", ")}
                      {operator.validatorIndices.length > 5
                        ? ` +${operator.validatorIndices.length - 5}`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export default function OracleMonitor() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [network, setNetwork] = useState<NetworkKey>("mainnet");
  const [view, setView] = useState<ViewKey>("overview");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [openMessage, setOpenMessage] = useState<BusMessage | null>(null);
  const [selectedReport, setSelectedReport] = useState<BusMessage | null>(null);
  // Multi-select filters: an empty list means the filter is off.
  const [moduleFilter, setModuleFilter] = useState<ModuleKey[]>([]);
  const [eventFilter, setEventFilter] = useState<TelemetryEvent[]>([]);
  const [telemetryHolderFilter, setTelemetryHolderFilter] = useState<string[]>(
    [],
  );
  const [oracleModuleFilter, setOracleModuleFilter] = useState<ModuleKey[]>([]);
  const [oraclePhaseFilter, setOraclePhaseFilter] = useState<ReportPhase[]>([]);
  const [oracleHolderFilter, setOracleHolderFilter] = useState<string[]>([]);
  const [hashVoteFrames, setHashVoteFrames] = useState(
    DEFAULT_HASH_VOTE_FRAMES,
  );
  // Report API responses by network and hash vote depth.
  const [oraclePayloads, setOraclePayloads] = useState<
    Partial<Record<string, OracleReportsPayload>>
  >({});
  const [oracleLoading, setOracleLoading] = useState(false);
  const [oracleError, setOracleError] = useState<string | null>(null);
  const [selectedOracleReport, setSelectedOracleReport] =
    useState<ParsedOracleReport | null>(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState(false);

  const routeFor = useCallback(
    (
      nextView: ViewKey,
      nextNetwork = network,
      overrides: Partial<RouteFilters> = {},
    ) => {
      const filters: RouteFilters = {
        modules: moduleFilter,
        events: eventFilter,
        telemetryHolders: telemetryHolderFilter,
        query,
        oracleModules: oracleModuleFilter,
        phases: oraclePhaseFilter,
        holders: oracleHolderFilter,
        frames: hashVoteFrames,
        ...overrides,
      };
      const params = new URLSearchParams();
      params.set("network", nextNetwork);
      const setList = (name: string, values: readonly string[]) => {
        if (values.length) params.set(name, values.join(","));
      };
      // Modules and holders differ per network, so the ones missing on the
      // next network do not survive a switch.
      const networkModules = moduleKeysFor(nextNetwork);
      const networkHolders = (holders: readonly string[]) =>
        holders.filter((holder) =>
          HOLDER_CONTRACTS[nextNetwork].includes(holder),
        );
      if (nextView === "telemetry") {
        setList(
          "module",
          filters.modules.filter((key) => networkModules.includes(key)),
        );
        setList("event", filters.events);
        setList("holder", networkHolders(filters.telemetryHolders));
        if (filters.query.trim()) params.set("search", filters.query.trim());
      }
      if (nextView === "oracle") {
        setList(
          "module",
          filters.oracleModules.filter((key) => networkModules.includes(key)),
        );
        setList("phase", filters.phases);
        setList("holder", networkHolders(filters.holders));
        if (filters.frames !== DEFAULT_HASH_VOTE_FRAMES) {
          params.set("frames", String(filters.frames));
        }
      }
      // Keep the commas of the lists readable.
      return `${VIEW_ROUTES[nextView]}?${params.toString().replaceAll("%2C", ",")}`;
    },
    [
      eventFilter,
      hashVoteFrames,
      moduleFilter,
      network,
      oracleHolderFilter,
      oracleModuleFilter,
      oraclePhaseFilter,
      query,
      telemetryHolderFilter,
    ],
  );

  const currentRouteUrl =
    typeof window === "undefined"
      ? routeFor(view)
      : new URL(routeFor(view), window.location.origin).toString();

  // The URL is the source of truth for the view, network and filters. The
  // state is adjusted during render when the route changes, so the first
  // render of a new route already shows the right screen.
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const [syncedRouteKey, setSyncedRouteKey] = useState<string | null>(null);
  if (syncedRouteKey !== routeKey) {
    setSyncedRouteKey(routeKey);
    const nextView = viewFromPath(pathname);
    const nextNetwork = safeNetwork(searchParams.get("network"));
    const nextModules = parseSelection(
      searchParams.get("module"),
      moduleKeysFor(nextNetwork),
    );
    const nextQuery = searchParams.get("search") ?? searchParams.get("q") ?? "";
    const nextHolders = parseSelection(
      searchParams.get("holder"),
      HOLDER_CONTRACTS[nextNetwork],
    );
    setView(nextView);
    setNetwork(nextNetwork);
    if (nextView === "telemetry") {
      setModuleFilter(nextModules);
      setEventFilter(
        parseSelection(searchParams.get("event"), TELEMETRY_EVENT_KEYS),
      );
      setTelemetryHolderFilter(nextHolders);
      setQuery(nextQuery);
    } else {
      setQuery("");
    }
    if (nextView === "oracle") {
      setOracleModuleFilter(nextModules);
      setOraclePhaseFilter(
        parseSelection(searchParams.get("phase"), REPORT_PHASE_KEYS),
      );
      setOracleHolderFilter(nextHolders);
      setHashVoteFrames(safeHashVoteFrames(searchParams.get("frames")));
    }
    setSelectedReport(null);
    setSelectedOracleReport(null);
  }

  const navigate = useCallback(
    (
      nextView: ViewKey,
      nextNetwork = network,
      overrides?: Partial<RouteFilters>,
    ) => {
      // The route sync above runs only after the navigation commits. Apply a
      // new selection right away, so the chips respond at once and a quick
      // second click builds on the first one.
      if (overrides?.modules) setModuleFilter(overrides.modules);
      if (overrides?.events) setEventFilter(overrides.events);
      if (overrides?.telemetryHolders)
        setTelemetryHolderFilter(overrides.telemetryHolders);
      if (overrides?.oracleModules) setOracleModuleFilter(overrides.oracleModules);
      if (overrides?.phases) setOraclePhaseFilter(overrides.phases);
      if (overrides?.holders) setOracleHolderFilter(overrides.holders);
      router.push(routeFor(nextView, nextNetwork, overrides));
    },
    [network, routeFor, router],
  );

  const rpcChoiceRaw = useSyncExternalStore(
    subscribeRpcChoice,
    readRpcChoiceRaw,
    () => "",
  );
  const rpcChoice = useMemo(() => parseRpcChoice(rpcChoiceRaw), [rpcChoiceRaw]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchSnapshot(rpcChoice);
      setSnapshot(next);
      setUpdatedAt(new Date());
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load onchain state",
      );
    } finally {
      setLoading(false);
    }
  }, [rpcChoice]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(load, 5 * 60 * 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  const oraclePayloadKey = `${network}:${hashVoteFrames}`;
  useEffect(() => {
    if (view !== "oracle" || oraclePayloads[oraclePayloadKey]) return;
    const controller = new AbortController();
    const start = window.setTimeout(() => {
      setOracleLoading(true);
      setOracleError(null);
      fetch(`/api/oracle-reports?network=${network}&frames=${hashVoteFrames}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json()) as
            | OracleReportsPayload
            | { error?: string };
          if (!response.ok || !("reports" in payload)) {
            throw new Error(
              "error" in payload && payload.error
                ? payload.error
                : "Unable to load oracle reports",
            );
          }
          setOraclePayloads((current) => ({
            ...current,
            [oraclePayloadKey]: payload,
          }));
        })
        .catch((loadError) => {
          if (
            loadError instanceof DOMException &&
            loadError.name === "AbortError"
          )
            return;
          setOracleError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load oracle reports",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setOracleLoading(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(start);
      controller.abort();
    };
  }, [hashVoteFrames, network, oraclePayloadKey, oraclePayloads, view]);

  const copied = useCallback(() => {
    setToast(true);
    window.setTimeout(() => setToast(false), 1600);
  }, []);

  const data = snapshot?.[network] ?? null;
  const memberMessages = useMemo(() => {
    if (!data) return new Map<string, Map<ModuleKey, BusMessage>>();
    const map = new Map<string, Map<ModuleKey, BusMessage>>();
    for (const message of data.messages) {
      // A startup alone is not a heartbeat: an oracle that keeps restarting
      // without reporting must show as stale.
      if (
        message.module === "unknown" ||
        message.event === "startup" ||
        !message.memberAddress
      )
        continue;
      const modules = map.get(message.memberAddress) ?? new Map();
      if (!modules.has(message.module)) modules.set(message.module, message);
      map.set(message.memberAddress, modules);
    }
    return map;
  }, [data]);

  const networkModules = useMemo(
    () => availableModules(NETWORKS[network].consensus),
    [network],
  );
  // Latest startup message per member and module: carries the Keys API
  // version and the DelegationContract the oracle was configured with.
  // Latest message and latest startup per holder and module. Startups carry
  // the Keys API version; heartbeats exclude startups.
  const holderTelemetry = useMemo(() => {
    const latest = new Map<string, Map<ModuleKey, BusMessage>>();
    const startups = new Map<string, Map<ModuleKey, BusMessage>>();
    if (!data) return { latest, startups };
    for (const message of data.messages) {
      if (message.module === "unknown" || !message.holderAddress) continue;
      const target = message.event === "startup" ? startups : latest;
      const modules =
        target.get(message.holderAddress) ?? new Map<ModuleKey, BusMessage>();
      if (!modules.has(message.module)) modules.set(message.module, message);
      target.set(message.holderAddress, modules);
    }
    return { latest, startups };
  }, [data]);

  // Holder (DelegationContract) behind each member row: the contract itself,
  // its delegate key, or a legacy EOA of the same operator.
  const holderByMember = useMemo(() => {
    const map = new Map<string, Holder>();
    if (!data) return map;
    for (const holder of data.holders) {
      for (const sender of holder.senders) {
        if (!map.has(sender)) map.set(sender, holder);
      }
    }
    return map;
  }, [data]);
  const nowSeconds = Math.floor((updatedAt?.getTime() ?? 0) / 1000);

  // Members that did not vote for the current or the previous frame.
  const missedReportCount = useMemo(() => {
    if (!data) return 0;
    return data.members.reduce(
      (total, member) =>
        total +
        networkModules.filter(
          ({ key }) =>
            member.lastSlots[key] !== undefined &&
            voteStateFor(member.lastSlots[key], data.frames[key]) === "missed",
        ).length,
      0,
    );
  }, [data, networkModules]);

  const staleCount = useMemo(() => {
    if (!data) return 0;
    return data.members.reduce((total, member) => {
      const modules = memberMessages.get(member.address);
      return (
        total +
        networkModules.filter(({ key }) => {
          const message = modules?.get(key);
          return !message || message.ageSeconds > STALE_SECONDS;
        }).length
      );
    }, 0);
  }, [data, memberMessages, networkModules]);
  const trackedBalances =
    data?.members.flatMap((member) => [
      member.balanceEth,
      ...(member.telemetryBalanceEth === undefined ||
      (network === "hoodi" &&
        member.telemetryAddress === (member.delegateAddress ?? member.address))
        ? []
        : [member.telemetryBalanceEth]),
    ]) ?? [];
  const lowestBalance = trackedBalances.length
    ? Math.min(...trackedBalances)
    : 0;
  // On Mainnet the telemetry key is separate from the oracle wallet, so a
  // member without a known telemetry key counts as a wallet to check.
  const missingTelemetryBalanceCount =
    network === "mainnet"
      ? (data?.members.filter(
          (member) => member.telemetryBalanceEth === undefined,
        ).length ?? 0)
      : 0;
  const lowBalanceCount =
    trackedBalances.filter((balance) => balance < LOW_BALANCE_ETH).length +
    missingTelemetryBalanceCount;

  // Messages that pass the search and the module, event and holder filters,
  // with the number of found messages per option for the filter menus.
  const telemetryFilter = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = (data?.messages ?? []).filter(
      (message) =>
        !needle ||
        message.sender.includes(needle) ||
        (LABELS[message.memberAddress ?? message.holderAddress ?? message.sender] ?? "")
          .toLowerCase()
          .includes(needle) ||
        message.transactionHash.toLowerCase().includes(needle) ||
        String(message.blockNumber).includes(needle),
    );
    return filterWithCounts(found, {
      module: { selected: moduleFilter, valueOf: (message) => message.module },
      event: { selected: eventFilter, valueOf: (message) => message.event },
      holder: {
        selected: telemetryHolderFilter,
        valueOf: (message) => message.holderAddress,
      },
    });
  }, [data, eventFilter, moduleFilter, query, telemetryHolderFilter]);
  const filteredReports = telemetryFilter.items;

  const visibleReport = selectedReport ?? filteredReports[0] ?? null;
  const oraclePayload = oraclePayloads[oraclePayloadKey];
  const oracleFilter = useMemo(
    () =>
      filterWithCounts(oraclePayload?.reports ?? [], {
        module: {
          selected: oracleModuleFilter,
          valueOf: (report) => report.module,
        },
        phase: {
          selected: oraclePhaseFilter,
          valueOf: (report) => report.phase,
        },
        holder: {
          selected: oracleHolderFilter,
          valueOf: (report) =>
            holderContractFor(network, report.sender, holderByMember),
        },
      }),
    [
      holderByMember,
      network,
      oracleHolderFilter,
      oracleModuleFilter,
      oraclePayload,
      oraclePhaseFilter,
    ],
  );
  const filteredOracleReports = oracleFilter.items;
  const visibleOracleReport =
    selectedOracleReport ?? filteredOracleReports[0] ?? null;

  const explorer = NETWORKS[network].explorer;
  const moduleOptions: FilterOption<ModuleKey>[] = networkModules.map(
    ({ key, label, full }) => ({ value: key, label, title: full }),
  );
  const phaseOptions: FilterOption<ReportPhase>[] = REPORT_PHASES.map(
    ({ key, label, full }) => ({ value: key, label, title: full }),
  );
  const eventOptions: FilterOption<TelemetryEvent>[] = TELEMETRY_EVENT_KINDS.map(
    ({ key, label, full }) => ({ value: key, label, title: full }),
  );
  const holderOptions: FilterOption<string>[] = (data?.holders ?? []).map(
    (holder) => ({
      value: holder.contract,
      label: holder.label,
      title: holder.contract,
    }),
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Radio size={18} />
          </span>
          <div>
            <strong>Lido Oracle Watch</strong>
            <span>Onchain operations console</span>
          </div>
        </div>
        <nav className="view-tabs" aria-label="Monitor views">
          <button
            type="button"
            className={view === "overview" ? "active" : ""}
            onClick={() => navigate("overview")}
          >
            <Activity size={16} /> Overview
          </button>
          <button
            type="button"
            className={view === "telemetry" ? "active" : ""}
            onClick={() => navigate("telemetry")}
          >
            <FileJson size={16} /> Telemetry details
          </button>
          <button
            type="button"
            className={view === "oracle" ? "active" : ""}
            onClick={() => navigate("oracle")}
          >
            <ListTree size={16} /> Oracle reports
          </button>
        </nav>
        <div className="top-actions">
          <span className="updated">
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Live RPC"}
          </span>
          <RouteButton value={currentRouteUrl} onCopied={copied} />
          <button
            className="refresh-button"
            type="button"
            onClick={() => {
              void load();
              if (view === "oracle") {
                setOraclePayloads((current) =>
                  Object.fromEntries(
                    Object.entries(current).filter(
                      ([key]) => !key.startsWith(`${network}:`),
                    ),
                  ),
                );
              }
            }}
            disabled={loading || oracleLoading}
          >
            <RefreshCw
              className={loading || oracleLoading ? "spin" : ""}
              size={16}
            />
            Refresh
          </button>
        </div>
      </header>

      <section className="context-bar">
        <div className="network-switch" aria-label="Network">
          {(["mainnet", "hoodi"] as const).map((key) => (
            <button
              type="button"
              key={key}
              className={network === key ? "active" : ""}
              onClick={() => {
                setSelectedReport(null);
                setSelectedOracleReport(null);
                navigate(view, key);
              }}
            >
              <span className={`network-dot ${key}`} />
              {NETWORKS[key].label}
              <small>{NETWORKS[key].chainLabel}</small>
            </button>
          ))}
        </div>
        <div className="chain-state">
          <RpcPicker
            network={network}
            choice={rpcChoice}
            connectedUrl={data?.rpcUrl}
            onChange={(url) =>
              writeRpcChoice({ ...rpcChoice, [network]: url || undefined })
            }
          />
          {data && (
            <>
              <span>Block {data.blockNumber.toLocaleString()}</span>
              <a
                href={`${DATABUS_EXPLORER}/address/${DATABUS}`}
                target="_blank"
                rel="noreferrer"
              >
                DataBus {shorten(DATABUS)}
                <ExternalLink size={13} />
              </a>
            </>
          )}
        </div>
      </section>

      {loading && !snapshot ? (
        <LoadingState />
      ) : error && !snapshot ? (
        <section className="error-state">
          <AlertTriangle size={22} />
          <div>
            <strong>Could not read the chains</strong>
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </section>
      ) : data ? (
        view === "overview" ? (
          <section className="workspace">
            <div className="summary-band">
              <div className="summary-intro">
                <div className="eyebrow">{NETWORKS[network].label} status</div>
                <h1>Oracle participation</h1>
                <p>
                  Committee membership from HashConsensus, cross-checked against
                  the latest DataBus heartbeat for every module.
                </p>
              </div>
              <div className="metric">
                <span>Members</span>
                <strong>{data.members.length}</strong>
                <small>authoritative set</small>
              </div>
              <div
                className={`metric ${lowBalanceCount ? "warning" : "healthy"}`}
              >
                <span>Lowest balance</span>
                <strong>{formatBalance(lowestBalance)}</strong>
                <small>
                  ETH ·{" "}
                  {lowBalanceCount
                    ? `${lowBalanceCount} wallet${
                        lowBalanceCount === 1 ? "" : "s"
                      } below ${LOW_BALANCE_ETH} ETH`
                    : "all wallets funded"}
                </small>
              </div>
              <div className={`metric ${missedReportCount ? "warning" : "healthy"}`}>
                <span>Missed reports</span>
                <strong>{missedReportCount}</strong>
                <small>
                  {missedReportCount
                    ? "no vote in the last frame"
                    : "every seat voted"}
                </small>
              </div>
              <div className={`metric ${staleCount ? "warning" : "healthy"}`}>
                <span>Telemetry breaches</span>
                <strong>{staleCount}</strong>
                <small>{staleCount ? "silent over 24h" : "all current"}</small>
              </div>
            </div>

            <section className="panel participation-panel">
              <header className="panel-header">
                <div>
                  <h2>Participation matrix</h2>
                  <p>
                    Current members and each module’s latest DataBus telemetry.
                  </p>
                </div>
                <div className="legend">
                  <span>
                    <i className="legend-good" /> reported, telemetry within 24h
                  </span>
                  <span>
                    <i className="legend-partial" /> reported, telemetry silent
                  </span>
                  <span>
                    <i className="legend-overdue" /> no report in the last frame
                  </span>
                </div>
              </header>
              <div className="table-scroll">
                <div
                  className="matrix"
                  role="table"
                  style={{ "--matrix-modules": networkModules.length } as React.CSSProperties}
                >
                  <div className="matrix-head" role="row">
                    <span role="columnheader">Oracle member</span>
                    {networkModules.map((module) => (
                      <span role="columnheader" key={module.key} title={module.full}>
                        {module.label}
                      </span>
                    ))}
                  </div>
                    {data.members.map((member) => {
                      const holder = holderByMember.get(member.address);
                      const state = holder?.state;
                      // Seat held by the contract itself, or by a legacy EOA
                      // (or delegate key) of the operator that owns a contract.
                      const seat: SeatKind | undefined = !holder
                        ? undefined
                        : holder.contract === member.address
                          ? "contract"
                          : state?.delegateAddress === member.address
                            ? "delegate"
                            : "legacy";
                      // Wallet that signs reports: the delegate key of the
                      // contract holding the seat, otherwise the member EOA.
                      const walletAddress = member.delegateAddress ?? member.address;
                      const versions = holder
                        ? {
                            latest: holderTelemetry.latest.get(holder.contract),
                            startups: holderTelemetry.startups.get(holder.contract),
                          }
                        : undefined;
                      // On Hoodi the telemetry key is often the wallet itself; on
                      // Mainnet the same address holds a separate Hoodi balance.
                      const sameWallet =
                        network === "hoodi" && member.telemetryAddress === walletAddress;
                      return (
                        <div className="matrix-row" role="row" key={member.address}>
                          <div className="member-card" role="cell">
                              <div className="member-details">
                                <strong>
                                  {LABELS[member.address] ?? "Unknown operator"}
                                  {seat && (
                                    <span className={`holder-seat ${seat}`}>
                                      {seat === "contract"
                                        ? "Contract"
                                        : seat === "delegate"
                                          ? "Delegate key"
                                          : "Legacy EOA"}
                                    </span>
                                  )}
                                  {state?.terminated && (
                                    <span className="holder-seat terminated">
                                      Terminated
                                    </span>
                                  )}
                                </strong>
                                <dl className="member-facts">
                                  <div>
                                    <dt>{seat === "contract" ? "Contract" : "Member"}</dt>
                                    <dd>
                                      <AddressLink address={member.address} explorer={explorer} head={6} tail={4} />
                                    </dd>
                                  </div>
                                  {holder && seat !== "contract" && (
                                    <div>
                                      <dt>Contract</dt>
                                      <dd>
                                        <AddressLink address={holder.contract} explorer={explorer} head={6} tail={4} />
                                      </dd>
                                    </div>
                                  )}
                                  {state && (
                                    <div>
                                      <dt>Owner</dt>
                                      <dd>
                                        <AddressLink address={state.ownerAddress} explorer={explorer} head={6} tail={4} />
                                      </dd>
                                    </div>
                                  )}
                                  {state && (
                                    <div>
                                      <dt>Delegate</dt>
                                      <dd>
                                        <AddressLink address={state.delegateAddress} explorer={explorer} head={6} tail={4} />
                                        {seat !== "contract" && (
                                          <span className="muted">not the member yet</span>
                                        )}
                                      </dd>
                                    </div>
                                  )}
                                  {state?.pendingDelegateAddress && (
                                    <div>
                                      <dt>Pending</dt>
                                      <dd>
                                        <AddressLink address={state.pendingDelegateAddress} explorer={explorer} head={6} tail={4} />
                                        <span className="muted">
                                          {state.pendingActiveFrom !== undefined &&
                                          state.pendingActiveFrom > nowSeconds
                                            ? `from ${formatTime(state.pendingActiveFrom)}`
                                            : "settling"}
                                        </span>
                                      </dd>
                                    </div>
                                  )}
                                  {state && (
                                    <div>
                                      <dt>Terminated</dt>
                                      <dd>
                                        <span className={state.terminated ? "status-bad" : "status-ok"}>
                                          {state.terminated === undefined
                                            ? "n/a"
                                            : state.terminated
                                              ? "yes"
                                              : "no"}
                                        </span>
                                        <span className="muted">
                                          · cooldown{" "}
                                          {state.cooldownSeconds !== undefined
                                            ? formatDuration(state.cooldownSeconds)
                                            : "n/a"}
                                        </span>
                                      </dd>
                                    </div>
                                  )}
                                </dl>
                                <div className="wallet-chips">
                                  <BalanceChip
                                    label="Wallet"
                                    address={walletAddress}
                                    balanceEth={member.balanceEth}
                                    explorer={explorer}
                                  />
                                  {!sameWallet && (
                                    <BalanceChip
                                      label="Telemetry"
                                      address={member.telemetryAddress}
                                      balanceEth={member.telemetryBalanceEth}
                                      explorer={DATABUS_EXPLORER}
                                    />
                                  )}
                                </div>
                              </div>
                          </div>
                          {networkModules.map(({ key }) => {
                            const message = memberMessages
                              .get(member.address)
                              ?.get(key);
                            const recent =
                              !!message &&
                              message.ageSeconds <= STALE_SECONDS;
                            const slot = member.lastSlots[key];
                            const frame = data.frames[key];
                            const vote = voteStateFor(slot, frame);
                            const reported = vote === "current" || vote === "previous";
                            // Four states, named in words inside the tile:
                            // reported + telemetry, reported only, telemetry
                            // only, nothing.
                            const tone =
                              vote === "unknown"
                                ? recent
                                  ? "recent"
                                  : "overdue"
                                : reported
                                  ? recent
                                    ? "recent"
                                    : "partial"
                                  : "overdue";
                            const voteText =
                              vote === "current"
                                ? `Reported · ref slot ${slot?.toLocaleString()}`
                                : vote === "previous"
                                  ? `Reported · previous frame ${slot?.toLocaleString()}`
                                  : vote === "missed"
                                    ? slot
                                      ? `Not reported · last ref slot ${slot.toLocaleString()}`
                                      : "Not reported · never voted"
                                    : "Not in this committee";
                            const telemetryText = message
                              ? recent
                                ? `Telemetry ${relativeTime(message.ageSeconds)} · #${message.blockNumber.toLocaleString()}`
                                : `Telemetry silent · last ${relativeTime(message.ageSeconds)}`
                              : "No telemetry in 7d";
                            const version =
                              versions?.latest?.get(key)?.version ??
                              versions?.startups?.get(key)?.version;
                            const kapiVersion = versions?.startups?.get(key)?.kapiVersion;
                            return (
                              <div role="cell" key={key}>
                                <div
                                  className={`slot-cell ${tone}`}
                                  title={[
                                    voteText,
                                    frame
                                      ? `current frame ref slot ${frame.refSlot.toLocaleString()}`
                                      : "",
                                    telemetryText,
                                    message ? formatTime(message.timestamp) : "",
                                  ]
                                    .filter(Boolean)
                                    .join("\n")}
                                >
                                  <span className="slot-ok">
                                    {reported || (vote === "unknown" && recent) ? (
                                      <CheckCircle2 size={15} />
                                    ) : (
                                      <AlertTriangle size={15} />
                                    )}
                                    {vote === "unknown"
                                      ? recent
                                        ? "Telemetry ok"
                                        : "Telemetry silent"
                                      : reported
                                        ? "Reported"
                                        : "Not reported"}
                                  </span>
                                  <span className="slot-relative">
                                    {vote === "unknown"
                                      ? telemetryText
                                      : voteText.replace(/^(Reported|Not reported) · /, "")}
                                  </span>
                                  {vote !== "unknown" && (
                                    <span className={`slot-telemetry ${recent ? "" : "silent"}`}>
                                      {telemetryText}
                                    </span>
                                  )}
                                  {(version || kapiVersion) && (
                                    <span className="slot-versions">
                                      {version ?? "—"} · KAPI {kapiVersion ?? "—"}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                </div>
              </div>
            </section>

          </section>
        ) : view === "telemetry" ? (
          <section className="workspace reports-workspace">
            <div className="reports-heading">
              <div>
                <div className="eyebrow">
                  {NETWORKS[network].label} · block by block
                </div>
                <h1>Telemetry details</h1>
                <p>
                  Inspect every captured telemetry payload of the tracked modules in
                  descending block order.
                </p>
              </div>
              <div className="reports-count">
                <strong>{filteredReports.length}</strong>
                <span>matching messages</span>
              </div>
            </div>

            <div className="filter-bar" role="group" aria-label="Filters">
              <FilterMenu
                label="Module"
                options={moduleOptions}
                selected={moduleFilter}
                counts={telemetryFilter.counts.module}
                onChange={(modules) => {
                  setSelectedReport(null);
                  navigate("telemetry", network, { modules });
                }}
              />
              <FilterMenu
                label="Event"
                options={eventOptions}
                selected={eventFilter}
                counts={telemetryFilter.counts.event}
                onChange={(events) => {
                  setSelectedReport(null);
                  navigate("telemetry", network, { events });
                }}
              />
              <FilterMenu
                label="Holder"
                options={holderOptions}
                selected={telemetryHolderFilter}
                counts={telemetryFilter.counts.holder}
                onChange={(telemetryHolders) => {
                  setSelectedReport(null);
                  navigate("telemetry", network, { telemetryHolders });
                }}
              />
              <label className="search-field">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => {
                    const nextQuery = event.target.value;
                    setQuery(nextQuery);
                    setSelectedReport(null);
                    router.replace(
                      routeFor("telemetry", network, { query: nextQuery }),
                      { scroll: false },
                    );
                  }}
                  placeholder="Search member, block, or tx"
                  aria-label="Search reports"
                />
              </label>
              <button
                type="button"
                className="filter-reset"
                disabled={
                  !moduleFilter.length &&
                  !eventFilter.length &&
                  !telemetryHolderFilter.length &&
                  !query
                }
                onClick={() => {
                  setQuery("");
                  setSelectedReport(null);
                  navigate("telemetry", network, {
                    modules: [],
                    events: [],
                    telemetryHolders: [],
                    query: "",
                  });
                }}
              >
                Reset
              </button>
            </div>

            <div className="reports-layout">
              <section className="report-ledger" aria-label="Report ledger">
                <header className="ledger-header">
                  <span>Block / module</span>
                  <span>Sender</span>
                  <span>Age</span>
                </header>
                <div className="ledger-rows">
                  {filteredReports.length ? (
                    filteredReports.slice(0, 500).map((message) => (
                      <button
                        type="button"
                        key={`${message.transactionHash}-${message.module}`}
                        className={
                          visibleReport?.transactionHash === message.transactionHash
                            ? "active"
                            : ""
                        }
                        onClick={() => setSelectedReport(message)}
                      >
                        <span className="ledger-block">
                          <strong>#{message.blockNumber.toLocaleString()}</strong>
                          <ModulePill module={message.module} />
                          <span className="ledger-event">
                            {eventLabel(message.event)}
                          </span>
                        </span>
                        <span className="ledger-sender">
                          <strong>
                            {LABELS[
                              message.memberAddress ??
                                message.holderAddress ??
                                message.sender
                            ] ?? "Unknown operator"}
                          </strong>
                          <small>{shorten(message.sender, 5, 4)}</small>
                        </span>
                        <span
                          className={
                            message.ageSeconds > STALE_SECONDS
                              ? "ledger-age stale"
                              : "ledger-age"
                          }
                        >
                          {relativeTime(message.ageSeconds)}
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))
                  ) : (
                    <div className="no-results">
                      <Search size={20} />
                      <strong>No reports match this filter</strong>
                      <span>Try another filter or search term.</span>
                    </div>
                  )}
                  {filteredReports.length > 500 && (
                    <div className="ledger-limit">
                      Showing the latest 500 of{" "}
                      {filteredReports.length.toLocaleString()} matching reports
                    </div>
                  )}
                </div>
              </section>

              <aside className="report-inspector">
                {visibleReport ? (
                  <>
                    <header className="inspector-header">
                      <div>
                        <div className="eyebrow">Selected report</div>
                        <h2>
                          Block {visibleReport.blockNumber.toLocaleString()}
                        </h2>
                      </div>
                      <div className="inspector-actions">
                        <CopyButton
                          value={visibleReport.pretty}
                          onCopied={copied}
                          label="Copy formatted report"
                        />
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => setOpenMessage(visibleReport)}
                          aria-label="Expand report"
                          title="Expand report"
                        >
                          <Maximize2 size={15} />
                        </button>
                      </div>
                    </header>
                    <div className="report-metadata">
                      <div>
                        <span>Module</span>
                        <ModulePill module={visibleReport.module} />
                        <span className="ledger-event">
                          {eventLabel(visibleReport.event)}
                        </span>
                      </div>
                      <div>
                        <span>Sender</span>
                        <strong>
                          {LABELS[
                            visibleReport.memberAddress ?? visibleReport.sender
                          ] ?? "Unknown operator"}
                        </strong>
                      </div>
                      <div>
                        <span>Observed</span>
                        <strong>{formatTime(visibleReport.timestamp)}</strong>
                      </div>
                      <div>
                        <span>Transaction</span>
                        <a
                          href={`${DATABUS_EXPLORER}/tx/${visibleReport.transactionHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shorten(visibleReport.transactionHash, 8, 6)}
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    </div>
                    <pre className="json-view compact">
                      {visibleReport.pretty}
                    </pre>
                  </>
                ) : (
                  <div className="inspector-empty">
                    <ServerCog size={24} />
                    <strong>Select a report</strong>
                    <span>Its decoded payload will appear here.</span>
                  </div>
                )}
              </aside>
            </div>
          </section>
        ) : (
          <section className="workspace reports-workspace oracle-workspace">
            <div className="reports-heading">
              <div>
                <div className="eyebrow">
                  {NETWORKS[network].label} · report transactions
                </div>
                <h1>Onchain oracle reports</h1>
                <p>
                  All report phases: hash votes in HashConsensus, decoded
                  submitReportData calls and Accounting Oracle extra data, sent
                  directly or through Execution Delegation Framework contracts.
                </p>
              </div>
              <div className="reports-count">
                <strong>{filteredOracleReports.length}</strong>
                <span>decoded transactions</span>
              </div>
            </div>

            {oraclePayload && (
              <div className="receiver-strip" aria-label="Oracle receivers">
                {availableModules(oraclePayload.contracts).map(({ key, full }) => (
                  <a
                    key={key}
                    href={`${explorer}/address/${oraclePayload.contracts[key]}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ModulePill module={key} />
                    <span>
                      <strong>{full}</strong>
                      <small>
                        {shorten(oraclePayload.contracts[key] as string, 7, 5)}
                      </small>
                    </span>
                    <ExternalLink size={12} />
                  </a>
                ))}
              </div>
            )}

            <div className="filter-bar" role="group" aria-label="Filters">
              <FilterMenu
                label="Module"
                options={moduleOptions}
                selected={oracleModuleFilter}
                counts={oracleFilter.counts.module}
                onChange={(oracleModules) => {
                  setSelectedOracleReport(null);
                  navigate("oracle", network, { oracleModules });
                }}
              />
              <FilterMenu
                label="Phase"
                options={phaseOptions}
                selected={oraclePhaseFilter}
                counts={oracleFilter.counts.phase}
                onChange={(phases) => {
                  setSelectedOracleReport(null);
                  navigate("oracle", network, { phases });
                }}
              />
              <FilterMenu
                label="Holder"
                options={holderOptions}
                selected={oracleHolderFilter}
                counts={oracleFilter.counts.holder}
                onChange={(holders) => {
                  setSelectedOracleReport(null);
                  navigate("oracle", network, { holders });
                }}
              />
              <span className="filter-divider" />
              <Dropdown label="Hash votes" value={`${hashVoteFrames} frames`}>
                {(close) =>
                  HASH_VOTE_FRAMES.map((frames) => (
                    <button
                      type="button"
                      key={frames}
                      role="menuitemradio"
                      aria-checked={hashVoteFrames === frames}
                      title={`Load hash votes of the latest ${frames} frames per module, within about 35 days of history`}
                      onClick={() => {
                        close();
                        setSelectedOracleReport(null);
                        navigate("oracle", network, { frames });
                      }}
                    >
                      <span className="filter-menu-box round">
                        {hashVoteFrames === frames && <i />}
                      </span>
                      Latest {frames} frames
                    </button>
                  ))
                }
              </Dropdown>
              <button
                type="button"
                className="filter-reset"
                disabled={
                  !oracleModuleFilter.length &&
                  !oraclePhaseFilter.length &&
                  !oracleHolderFilter.length
                }
                onClick={() => {
                  setSelectedOracleReport(null);
                  navigate("oracle", network, {
                    oracleModules: [],
                    phases: [],
                    holders: [],
                  });
                }}
              >
                Reset
              </button>
            </div>

            {oraclePayload?.warnings?.map((warning) => (
              <div className="report-warning" role="status" key={warning}>
                <AlertTriangle size={14} />
                {warning}
              </div>
            ))}

            {oracleLoading && !oraclePayload ? (
              <div className="loading-state report-loading" role="status">
                <LoaderCircle className="spin" size={22} />
                <div>
                  <strong>Decoding receiver transactions</strong>
                  <span>
                    Unwrapping delegated calldata and resolving block timestamps
                  </span>
                </div>
              </div>
            ) : oracleError && !oraclePayload ? (
              <section className="error-state">
                <AlertTriangle size={22} />
                <div>
                  <strong>Could not read oracle reports</strong>
                  <span>{oracleError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setOracleError(null);
                    setOraclePayloads((current) => ({ ...current }));
                  }}
                >
                  Try again
                </button>
              </section>
            ) : (
              <div className="reports-layout oracle-reports-layout">
                <section className="report-ledger" aria-label="Oracle report ledger">
                  <header className="ledger-header">
                    <span>Block / module / phase</span>
                    <span>Submitter</span>
                    <span>Age</span>
                  </header>
                  <div className="ledger-rows">
                    {filteredOracleReports.length ? (
                      filteredOracleReports.map((report) => {
                        const ageSeconds = Math.max(
                          0,
                          Math.floor((updatedAt?.getTime() ?? 0) / 1000) -
                            report.timestamp,
                        );
                        return (
                          <button
                            type="button"
                            key={reportKey(report)}
                            className={
                              visibleOracleReport &&
                              reportKey(visibleOracleReport) === reportKey(report)
                                ? "active"
                                : ""
                            }
                            onClick={() => setSelectedOracleReport(report)}
                          >
                            <span className="ledger-block">
                              <strong>#{report.blockNumber.toLocaleString()}</strong>
                              <span className="ledger-pills">
                                <ModulePill module={report.module} />
                                <PhasePill phase={report.phase} />
                              </span>
                            </span>
                            <span className="ledger-sender">
                              <strong>
                                {LABELS[report.sender] ??
                                  (report.phase === "hash"
                                    ? "Committee member"
                                    : "Authorized submitter")}
                              </strong>
                              <small>slot {report.refSlot.toLocaleString()}</small>
                            </span>
                            <span className="ledger-age">
                              {relativeTime(ageSeconds)}
                            </span>
                            <ChevronRight size={15} />
                          </button>
                        );
                      })
                    ) : (
                      <div className="no-results">
                        <ListTree size={20} />
                        <strong>No decoded reports in this filter</strong>
                        <span>
                          There may be no recent report activity for this
                          module, phase and holder.
                        </span>
                      </div>
                    )}
                  </div>
                </section>

                <aside className="report-inspector oracle-inspector">
                  {visibleOracleReport ? (
                    <OracleReportInspector
                      report={visibleOracleReport}
                      explorer={explorer}
                      onCopied={copied}
                    />
                  ) : (
                    <div className="inspector-empty">
                      <ServerCog size={24} />
                      <strong>Select an oracle report</strong>
                      <span>Its decoded fields will appear here.</span>
                    </div>
                  )}
                </aside>
              </div>
            )}
          </section>
        )
      ) : null}

      {openMessage && (
        <JsonModal
          message={openMessage}
          onClose={() => setOpenMessage(null)}
          onCopied={copied}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={15} /> Copied to clipboard
        </div>
      )}
      <footer className="app-footer">
        <span>
          <Clock3 size={13} /> Auto-refreshes every 5 minutes
        </span>
        <span>
          Membership: HashConsensus · Telemetry: DataBus · Reports:
          HashConsensus events and receiver calldata
        </span>
      </footer>
    </main>
  );
}
