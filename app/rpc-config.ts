// RPC endpoints per network. Defaults are public endpoints without API keys.
// They can be replaced through environment variables with comma-separated
// URLs:
// - NEXT_PUBLIC_MAINNET_RPC_URLS / NEXT_PUBLIC_HOODI_RPC_URLS are inlined at
//   build time and used by the browser (members, balances, DataBus logs).
// - MAINNET_RPC_URLS / HOODI_RPC_URLS are read at runtime by the report API.
//   These endpoints must serve eth_getLogs over 10k-block ranges for about
//   35 days of history in batches of five calls.

export const MAINNET_CHAIN_ID = 1;
export const HOODI_CHAIN_ID = 560_048;

const DEFAULT_BROWSER_RPCS = {
  mainnet: ["https://ethereum.publicnode.com", "https://eth.llamarpc.com"],
  hoodi: [
    "https://rpc.hoodi.ethpandaops.io",
    "https://hoodi.drpc.org",
    "https://ethereum-hoodi-rpc.publicnode.com",
  ],
};

// publicnode rejects log queries older than a few thousand blocks and
// flashbots keeps only recent logs, so they come after mevblocker and tenderly.
const DEFAULT_SERVER_RPCS = {
  mainnet: [
    "https://rpc.mevblocker.io",
    "https://gateway.tenderly.co/public/mainnet",
    "https://rpc.flashbots.net",
    "https://ethereum-rpc.publicnode.com",
  ],
  hoodi: [
    "https://rpc.hoodi.ethpandaops.io",
    "https://ethereum-hoodi-rpc.publicnode.com",
  ],
};

export function parseRpcList(
  value: string | undefined,
  defaults: readonly string[],
): readonly string[] {
  const urls = (value ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  return urls.length ? urls : defaults;
}

// NEXT_PUBLIC_* variables must be referenced literally so the build can
// inline them into the browser bundle.
export const BROWSER_RPCS = {
  mainnet: parseRpcList(
    process.env.NEXT_PUBLIC_MAINNET_RPC_URLS,
    DEFAULT_BROWSER_RPCS.mainnet,
  ),
  hoodi: parseRpcList(
    process.env.NEXT_PUBLIC_HOODI_RPC_URLS,
    DEFAULT_BROWSER_RPCS.hoodi,
  ),
};

export function serverRpcs(network: "mainnet" | "hoodi"): readonly string[] {
  return parseRpcList(
    network === "mainnet"
      ? process.env.MAINNET_RPC_URLS
      : process.env.HOODI_RPC_URLS,
    DEFAULT_SERVER_RPCS[network],
  );
}
