import { JsonRpcApiProvider, type JsonRpcPayload, type JsonRpcResult, type JsonRpcError } from "ethers";
import { createRpcReader, RpcReadError, RpcResponseError } from "./rpc-read.ts";

// Ethers normally batches up to 100 calls and parses HTTP error pages as JSON.
// Keep its contract decoding, but use the paced, retrying read transport. Auto
// can fail over on every request; an explicitly chosen source remains exclusive.
export class OracleReadProvider extends JsonRpcApiProvider {
  private readonly urls: readonly string[];
  private readonly read: ReturnType<typeof createRpcReader>;
  constructor(urls: readonly string[], chainId: number, options: Parameters<typeof createRpcReader>[0] = {}) {
    if (!urls.length) throw new Error("No Oracle RPC endpoints configured");
    super(chainId, { staticNetwork: true, batchMaxCount: 1 });
    this.urls = urls;
    this.read = createRpcReader({ ...options, expectedChainId: chainId, preserveRpcErrors: true });
    this._start();
  }
  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<(JsonRpcResult | JsonRpcError)[]> {
    return Promise.all((Array.isArray(payload) ? payload : [payload]).map(async item => {
      if (!Array.isArray(item.params)) throw new Error("Oracle reads require positional parameters");
      try {
        return { id: item.id, result: await this.read(this.urls, item.method, item.params) };
      } catch (error) {
        if (error instanceof RpcResponseError) return { id: item.id, error: error.rpcError };
        if (error instanceof RpcReadError) throw new Error("Oracle RPC data is temporarily unavailable after retries. Choose Auto or another RPC and try again.");
        throw error;
      }
    }));
  }
}
