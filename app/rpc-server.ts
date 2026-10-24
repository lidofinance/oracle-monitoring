import { AsyncLocalStorage } from "node:async_hooks";
import { serverRpcs as defaultRpcs } from "./rpc-config.ts";
import { RPC_OPTIONS, type RpcNetwork } from "./rpc-selection.ts";
const scope = new AsyncLocalStorage<{ network: RpcNetwork; id: string; url: string }>();
export function serverRpcs(network: RpcNetwork): readonly string[] {
  const selected = scope.getStore();
  return selected?.network === network ? [selected.url] : defaultRpcs(network);
}
export function rpcCacheKey(network: RpcNetwork): string {
  const selected = scope.getStore();
  return selected?.network === network ? `${network}-rpc-${selected.id}` : network;
}
export async function withRpcSelection<T extends Request>(request: T, handler: (request: T) => Promise<Response>): Promise<Response> {
  const network = new URL(request.url).searchParams.get("network");
  const id = request.headers.get("x-lido-rpc");
  if (id && (network === "mainnet" || network === "hoodi")) {
    // Only fixed public presets can be used by the server; never accept an
    // arbitrary URL or turn the monitor into a generic request proxy.
    const selected = RPC_OPTIONS[network].find(option => option.id === id);
    if (!selected) return Response.json({ error: "Choose a supported RPC endpoint for this network." }, { status: 400, headers: { "Cache-Control": "no-store", Vary: "x-lido-rpc" } });
    return scope.run({ network, ...selected }, async () => responseHeaders(await handler(request)));
  }
  return responseHeaders(await handler(request));
}
function responseHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  const vary = headers.get("Vary");
  headers.set("Vary", vary ? `${vary}, x-lido-rpc` : "x-lido-rpc");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
