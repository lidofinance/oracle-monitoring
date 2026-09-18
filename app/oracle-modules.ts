// Oracle modules tracked by the console. The keys match the module names the
// lido-oracle sends in DataBus telemetry (see `OracleModuleName` in
// lido-oracle), so telemetry can be attributed without a mapping table.
export type OracleModule = "ao" | "vebo" | "csm" | "csm_0x02" | "cm";

export const ORACLE_MODULES: ReadonlyArray<{
  key: OracleModule;
  label: string;
  full: string;
}> = [
  { key: "ao", label: "AO", full: "Accounting Oracle" },
  { key: "vebo", label: "VEBO", full: "Validator Exit Bus Oracle" },
  { key: "csm", label: "CSM", full: "Community Staking Module" },
  { key: "csm_0x02", label: "CSM 0x02", full: "Community Staking Module 0x02" },
  { key: "cm", label: "CM", full: "Curated Module" },
];

export function isOracleModule(value: unknown): value is OracleModule {
  return ORACLE_MODULES.some((module) => module.key === value);
}

// Not every module is deployed on every network. Given a per-network address
// map, return the modules that have a contract there, in display order.
export function availableModules<T>(
  contracts: Partial<Record<OracleModule, T>>,
) {
  return ORACLE_MODULES.filter(({ key }) => contracts[key] !== undefined);
}

// DataBus event ids sent by lido-oracle (keccak256 of the event name).
export type TelemetryEvent = "startup" | "report" | "diagnostic" | "unknown";

// keccak256("OracleStartup")
export const ORACLE_STARTUP_TOPIC =
  "0x84728a84725a206f8ec5a2ab533d0890029ade3fca0563b61dca1be60d73f40c";

const TELEMETRY_EVENTS: Record<string, TelemetryEvent> = {
  [ORACLE_STARTUP_TOPIC]: "startup",
  // keccak256("OracleReport")
  "0x2b819b2aa7a0f65647aa591f4b0db6b42b9cbd798674363c2217719c8ddc0126":
    "report",
  // keccak256("Diagnostic")
  "0xc175062d338aeb0f6c17720126be534a0113654b826c93e62a34bd23cbe58b36":
    "diagnostic",
};

export function telemetryEventFromTopic(topic: string): TelemetryEvent {
  return TELEMETRY_EVENTS[topic.toLowerCase()] ?? "unknown";
}

// Legacy DataBus topic (keccak256("accounting")), used only when a telemetry
// payload does not name its module.
const TOPIC_MODULES: Record<string, OracleModule> = {
  "0x0131b777a538d2509d6ec1bca91f61ac7a25b128baf35266feedf5a53eb4842a":
    "ao",
};

export type TelemetrySetup = {
  version?: string;
  kapiVersion?: string;
  delegationContract?: string;
};

// Setup details an oracle reports about itself: the oracle version is part of
// every message, the Keys API version and the DelegationContract address are
// sent in the startup message.
export function parseTelemetrySetup(raw: string): TelemetrySetup {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      data?: { kapi_version?: unknown; delegation_contract_address?: unknown };
    };
    const text = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const delegationContract = text(parsed.data?.delegation_contract_address);
    return {
      version: text(parsed.version),
      kapiVersion: text(parsed.data?.kapi_version),
      delegationContract: delegationContract?.toLowerCase(),
    };
  } catch {
    return {};
  }
}

export function moduleFromMessage(
  raw: string,
  topic: string,
): OracleModule | "unknown" {
  try {
    const parsed = JSON.parse(raw);
    const value = String(
      parsed.module ??
        parsed.module_name ??
        parsed.daemon ??
        parsed.component ??
        parsed.type ??
        "",
    ).toLowerCase();
    if (value.includes("account")) return "ao";
    if (value.includes("eject") || value.includes("exit")) return "vebo";
    if (value === "cm" || value.includes("cmv2") || value.includes("curated"))
      return "cm";
    // "csm_0x02" must be checked before the generic "csm" match.
    if (value.includes("0x02")) return "csm_0x02";
    if (value.includes("csm") || value.includes("community")) return "csm";
  } catch {
    const match = raw
      .toLowerCase()
      .match(/\b(accounting|ejector|exit|csm_0x02|csm|cmv2|curated)\b/);
    if (match?.[1] === "accounting") return "ao";
    if (match?.[1] === "ejector" || match?.[1] === "exit") return "vebo";
    if (match?.[1] === "csm_0x02") return "csm_0x02";
    if (match?.[1] === "csm") return "csm";
    if (match) return "cm";
  }
  return TOPIC_MODULES[topic.toLowerCase()] ?? "unknown";
}
