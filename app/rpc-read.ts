import { requestRetryDelay, retryableStatus, waitForRetry } from "./request-retry.ts";

type Failure = "rate-limit" | "network" | "http" | "rpc" | "empty";
type RpcErrorBody = { code: number; message?: string; data?: unknown };
export class RpcResponseError extends Error {
  rpcError: RpcErrorBody;
  constructor(error: RpcErrorBody) { super(error.message ?? "Ethereum RPC error"); this.rpcError = error; }
}
export class RpcReadError extends Error {
  method: string;
  reason: Failure;
  constructor(method: string, reason: Failure) {
    super(`Ethereum ${method} unavailable${reason === "rate-limit" ? ": RPC rate limit exceeded" : ""}`);
    this.method = method;
    this.reason = reason;
  }
}

// A shared scheduler prevents Promise.all batches and concurrent visitors from
// overwhelming one public RPC. Only idempotent Ethereum read methods are used.
export function createRpcReader(options: { fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; intervalMs?: number; expectedChainId?: number; preserveRpcErrors?: boolean } = {}) {
  const fetcher: typeof fetch = options.fetcher ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? waitForRetry, now = options.now ?? Date.now;
  const interval = options.intervalMs ?? 250;
  const verified = new Map<string, number>();
  const endpoints = new Map<string, { tail: Promise<void>; next: number; blockedUntil: number; active: number; waiters: (() => void)[] }>();
  function stateFor(url: string) {
    let state = endpoints.get(url);
    if (!state) { state = { tail: Promise.resolve(), next: 0, blockedUntil: 0, active: 0, waiters: [] }; endpoints.set(url, state); }
    return state;
  }
  async function scheduled<T>(url: string, run: () => Promise<T>, skipBlocked: boolean): Promise<T | null> {
    const state = stateFor(url);
    if (state.active >= 2) await new Promise<void>(resolve => state.waiters.push(resolve));
    else state.active++;
    let unlock!: () => void;
    const previous = state.tail;
    state.tail = new Promise<void>(resolve => { unlock = resolve; });
    try {
      await previous;
      if (skipBlocked && state.blockedUntil > now()) return null;
      while (Math.max(state.next, state.blockedUntil) > now()) await sleep(Math.max(state.next, state.blockedUntil) - now());
      state.next = now() + interval;
      unlock();
      return await run();
    } finally {
      unlock();
      const next = state.waiters.shift();
      if (next) next(); else state.active--;
    }
  }
  return async function read<T>(urls: readonly string[], method: string, params: unknown[]): Promise<T> {
    if (!/^eth_(chainId|blockNumber|getBlockByNumber|getLogs|getBalance|getCode|getTransactionByHash|getTransactionReceipt|call)$/.test(method)) throw new Error("Only Ethereum reads may be retried");
    let reason: Failure = "network";
    for (let attempt = 0; attempt < 3; attempt++) {
      let retry = false;
      for (const url of urls) {
        if (attempt === 0 && urls.length > 1 && stateFor(url).blockedUntil > now()) { retry = true; continue; }
        const result = await scheduled(url, async () => {
          const request = async (rpcMethod: string, rpcParams: unknown[]): Promise<{ value: unknown } | { error: RpcErrorBody } | null> => {
          try {
            const response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: rpcMethod, params: rpcParams }), signal: AbortSignal.timeout(8000), cache: "no-store" });
            const body = await response.json().catch(() => null) as { result?: unknown; error?: RpcErrorBody } | null;
            const limited = response.status === 429 || !!body?.error && /rate.limit|too many requests/i.test(body.error.message ?? "");
            if (limited) {
              reason = "rate-limit"; retry = true;
              stateFor(url).blockedUntil = Math.max(stateFor(url).blockedUntil, now() + requestRetryDelay(attempt, response.headers.get("retry-after"), now(), 0));
            } else if (!response.ok) {
              reason = "http"; retry ||= retryableStatus(response.status);
              stateFor(url).blockedUntil = Math.max(stateFor(url).blockedUntil, now() + 1000);
            } else if (!body || Array.isArray(body)) {
              reason = "network"; retry = true;
              stateFor(url).blockedUntil = Math.max(stateFor(url).blockedUntil, now() + 1000);
            } else if (body.error) {
              reason = "rpc";
              if (options.preserveRpcErrors && rpcMethod === "eth_call") return { error: body.error };
            }
            else if (body?.result !== undefined && body.result !== null) return { value: body.result };
            else reason = "empty";
          } catch { reason = "network"; retry = true; stateFor(url).blockedUntil = Math.max(stateFor(url).blockedUntil, now() + 1000); }
          return null;
          };
          if (options.expectedChainId !== undefined && (verified.get(url) ?? -Infinity) < now() - 600_000) {
            const chain = await request("eth_chainId", []);
            if (!chain || "error" in chain) return null;
            try {
              if (BigInt(String(chain.value)) !== BigInt(options.expectedChainId)) { reason = "rpc"; return null; }
            } catch { reason = "rpc"; return null; }
            verified.set(url, now());
            if (method === "eth_chainId") return chain;
          }
          return request(method, params);
        }, attempt === 0 && urls.length > 1);
        if (result && "error" in result) throw new RpcResponseError(result.error);
        if (result && "value" in result) return result.value as T;
      }
      if (!retry || attempt === 2) break;
      await sleep(requestRetryDelay(attempt, null, now(), 0));
    }
    throw new RpcReadError(method, reason);
  };
}
