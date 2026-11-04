import type { OracleModule as ModuleKey, TelemetryEvent } from "./oracle-modules";
import type { FrameInfo } from "./oracle-consensus";
import { CONSENSUS_CONTRACTS } from "./consensus-contracts";
import { BROWSER_RPCS } from "./rpc-config";
export type NetworkKey = "mainnet" | "hoodi";
// State of an EDF DelegationContract (LIP-37) read from the chain.
export type DelegationState = {
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
export type SeatKind = "contract" | "delegate" | "legacy";

// An oracle operator, identified by its DelegationContract.
export type Holder = {
  contract: string;
  label: string;
  state?: DelegationState;
  delegateBalanceEth?: number;
  seats: Partial<Record<ModuleKey, SeatKind>>;
  // Addresses whose telemetry belongs to this holder.
  senders: string[];
};

export type Member = {
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

export type BusMessage = {
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

export type ChainConfig = {
  secondsPerSlot: number;
  genesisTime: number;
};

export type NetworkSnapshot = {
  members: Member[];
  holders: Holder[];
  frames: Partial<Record<ModuleKey, FrameInfo>>;
  blockNumber: number;
  messages: BusMessage[];
  chainConfig: ChainConfig;
  rpcUrl: string;
  warnings: string[];
  telemetryLoading: boolean;
  fullHistoryLoaded: boolean;
};

export type Snapshot = Record<NetworkKey, NetworkSnapshot>;
export type RpcChoice = Partial<Record<NetworkKey, string>>;
export type NetworkConfig = {
  label: string;
  chainLabel: string;
  rpc: readonly string[];
  explorer: string;
  consensus: Partial<Record<ModuleKey, string>> & { ao: string };
};



export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
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

export const DATABUS = "0x37De961D6bb5865867aDd416be07189D2Dd960e6";
export const DATABUS_EXPLORER = "https://hoodi.etherscan.io";
// DataBus lookback in blocks (12s each): all messages for 7 days, startup
// messages for 30 days because oracles restart rarely.
export const TELEMETRY_LOOKBACK_BLOCKS = 50_400;
export const STARTUP_LOOKBACK_BLOCKS = 216_000;
export const MEMBER_ABI = [
  "function getMembers() view returns (address[] addresses, uint256[] lastReportedRefSlots)",
  "function getChainConfig() view returns (uint256 slotsPerEpoch, uint256 secondsPerSlot, uint256 genesisTime)",
  "function getCurrentFrame() view returns (uint256 refSlot, uint256 reportProcessingDeadlineSlot)",
  "function getFrameConfig() view returns (uint256 initialEpoch, uint256 epochsPerFrame, uint256 fastLaneLengthSlots)",
];
export const DELEGATION_ABI = [
  "function getDelegate() view returns (address)",
  "function owner() view returns (address)",
  "function getPendingDelegate() view returns (address delegate, uint256 activeFrom)",
  "function getCooldown() view returns (uint256)",
  "function isTerminated() view returns (bool)",
];
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Operator names by oracle member address. Both the pre-EDF member EOAs and
// the EDF DelegationContracts (LIP-37) are listed for Mainnet and Hoodi, so
// the console keeps working across the switch.
export const LABELS: Record<string, string> = {
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
export const HOLDER_CONTRACTS: Record<NetworkKey, readonly string[]> = {
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

