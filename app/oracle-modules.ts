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

// Legacy DataBus topic hashes, used only when a telemetry payload does not
// name its module.
const TOPIC_MODULES: Record<string, OracleModule> = {
  "0xc175062d338aeb0f6c17720126be534a0113654b826c93e62a34bd23cbe58b36":
    "cm",
  "0x84728a84725a206f8ec5a2ab533d0890029ade3fca0563b61dca1be60d73f40c":
    "csm",
  "0x2b819b2aa7a0f65647aa591f4b0db6b42b9cbd798674363c2217719c8ddc0126":
    "vebo",
  "0x0131b777a538d2509d6ec1bca91f61ac7a25b128baf35266feedf5a53eb4842a":
    "ao",
};

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
