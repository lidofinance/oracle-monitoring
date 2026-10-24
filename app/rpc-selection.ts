export type RpcNetwork = "mainnet" | "hoodi";
export type RpcChoice = Partial<Record<RpcNetwork, string>>;
export const RPC_STORAGE_KEY = "oracle-watch.rpc";
export const RPC_OPTIONS = {
  mainnet: [
    { id: "publicnode", label: "PublicNode", url: "https://ethereum-rpc.publicnode.com" },
    { id: "mevblocker", label: "MEV Blocker", url: "https://rpc.mevblocker.io" },
    { id: "tenderly", label: "Tenderly", url: "https://gateway.tenderly.co/public/mainnet" },
    { id: "llamarpc", label: "LlamaRPC", url: "https://eth.llamarpc.com" },
  ],
  hoodi: [
    { id: "publicnode", label: "PublicNode", url: "https://ethereum-hoodi-rpc.publicnode.com" },
    { id: "ethpandaops", label: "EthPandaOps", url: "https://rpc.hoodi.ethpandaops.io" },
    { id: "drpc", label: "dRPC", url: "https://hoodi.drpc.org" },
  ],
} as const;
export function parseRpcChoice(raw: string): RpcChoice {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>, choice: RpcChoice = {};
    for (const network of ["mainnet", "hoodi"] as const) {
      const url = value[network];
      // Migrate the previous Oracle PublicNode alias to the shared preset.
      const canonical = url === "https://ethereum.publicnode.com" ? "https://ethereum-rpc.publicnode.com" : url;
      if (RPC_OPTIONS[network].some(option => option.url === canonical)) choice[network] = canonical as string;
    }
    return choice;
  } catch { return {}; }
}
