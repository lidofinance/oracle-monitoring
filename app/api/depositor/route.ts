import { NextRequest, NextResponse } from "next/server";
import { Interface, id, isAddress } from "ethers";
import {
  LIDO_ABI, LOCATOR_ABI, DSM_ABI, EDF_ABI, GATEWAY_ABI, ROUTER_ABI, WITHDRAWAL_ABI, VEBO_ABI,
  ethAmount, unbufferedAmount, parseFinalization, parseVeboExitRequest,
  type DepositorSnapshot, type DepositorTransaction, type DepositorWallet,
} from "../../depositor-data";
import { serverRpcs } from "../../rpc-config";

type Network = "mainnet" | "hoodi";
type Block = { number: string; timestamp: string };
type Log = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string };
type Tx = { hash: string; from: string; to: string | null; blockNumber: string; input: string; gasPrice: string };
type Receipt = { status: string; gasUsed: string; effectiveGasPrice: string; logs: Log[] };
const CONFIG = {
  mainnet: { chainId: 1, locator: "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb", explorer: "https://etherscan.io" },
  hoodi: { chainId: 560048, locator: "0xe2EF9536DAAAEBFf5b1c130957AB3E80056b06D8", explorer: "https://hoodi.etherscan.io" },
};
const hex = (n: number) => `0x${n.toString(16)}`;
const num = (s: string) => Number(BigInt(s));
const ZERO = "0x0000000000000000000000000000000000000000";
const snapshots = new Map<Network, { expires: number; promise: Promise<DepositorSnapshot> }>();
const details = new Map<Network, { expires: number; promise: Promise<Pick<DepositorSnapshot, "history" | "transactions" | "withdrawals" | "withdrawalsComplete" | "veboRequests" | "veboComplete" | "activityFrom" | "activityTo" | "activityTruncated" | "warnings">> }>();

class Chain {
  network: Network;
  constructor(network: Network) { this.network = network; }
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    for (const endpoint of serverRpcs(this.network).slice(0, 3)) {
      try {
        const response = await fetch(endpoint, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(8000), cache: "no-store",
        });
        if (!response.ok) continue;
        const body = await response.json() as { result?: T; error?: unknown };
        if (!body.error && body.result !== undefined && body.result !== null) return body.result;
      } catch { /* Try the next configured provider, without exposing endpoint URLs. */ }
    }
    throw new Error(`Ethereum ${method} unavailable`);
  }
  async call(address: string, abi: Interface, method: string, args: unknown[], block: number) {
    const result = await this.rpc<string>("eth_call", [{ to: address, data: abi.encodeFunctionData(method, args) }, hex(block)]);
    return abi.decodeFunctionResult(method, result)[0];
  }
  async block(block: number | "latest") {
    return this.rpc<Block>("eth_getBlockByNumber", [block === "latest" ? block : hex(block), false]);
  }
}
async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await run(items[index]); }
  }));
  return results;
}

async function wallet(chain: Chain, holder: string, block: number): Promise<DepositorWallet> {
  const [delegate, owner, terminated, holderBalance] = await Promise.all([
    optional<string>(() => chain.call(holder, EDF_ABI, "getDelegate", [], block)),
    optional<string>(() => chain.call(holder, EDF_ABI, "owner", [], block)),
    optional<boolean>(() => chain.call(holder, EDF_ABI, "isTerminated", [], block)),
    optional(() => chain.rpc<string>("eth_getBalance", [holder, hex(block)])),
  ]);
  const sender = delegate && delegate !== ZERO ? delegate : holder;
  const balance = sender === holder ? holderBalance : await optional(() => chain.rpc<string>("eth_getBalance", [sender, hex(block)]));
  return { holder, delegate, owner, terminated, balance: balance ? ethAmount(balance) : null, holderBalance: holderBalance ? ethAmount(holderBalance) : null };
}

async function loadDetails(chain: Chain, block: number, addresses: DepositorSnapshot["addresses"]) {
  const warnings: string[] = [];
  const from = Math.max(0, block - 7 * 7200);
  // Events identify completed operations independently of the hot key's current
  // delegate. Rotation must not erase the previous delegate's transactions.
  const ranges: { start: number; end: number }[] = [];
  for (let start = from; start <= block; start += 9000) ranges.push({ start, end: Math.min(block, start + 8999) });
  const logSources = [
    { address: addresses.dsm, topic: DSM_ABI.getEvent("LastDepositBlockChanged")!.topicHash, kind: "deposit" as const },
    ...(addresses.gateway ? [{ address: addresses.gateway, topic: GATEWAY_ABI.getEvent("LastTopUpChanged")!.topicHash, kind: "topup" as const }] : []),
  ];
  const candidates = new Map<string, { hash: string; kind: "deposit" | "topup"; block: number }>();
  await mapLimit(logSources.flatMap((source) => ranges.map((range) => ({ ...source, ...range }))), 3, async ({ address, topic, kind, start, end }) => {
    const logs = await optional(() => chain.rpc<Log[]>("eth_getLogs", [{ address, topics: [topic], fromBlock: hex(start), toBlock: hex(end) }]));
    if (!logs) { warnings.push("Some activity ranges could not be loaded; transaction history is incomplete."); return; }
    for (const log of logs) candidates.set(log.transactionHash, { hash: log.transactionHash, kind, block: num(log.blockNumber) });
  });
  let withdrawalsComplete = true;
  const withdrawals = (await mapLimit(ranges, 3, async ({ start, end }) => {
    const logs = await optional(() => chain.rpc<Log[]>("eth_getLogs", [{
      address: addresses.withdrawalQueue,
      topics: [WITHDRAWAL_ABI.getEvent("WithdrawalsFinalized")!.topicHash],
      fromBlock: hex(start), toBlock: hex(end),
    }]));
    if (!logs) { withdrawalsComplete = false; return []; }
    return logs.flatMap((log) => {
      try { return [parseFinalization(log)]; }
      catch { withdrawalsComplete = false; return []; }
    });
  })).flat().sort((a, b) => b.block - a.block);
  if (!withdrawalsComplete) warnings.push("Some withdrawal finalizations could not be loaded; fulfilled totals are incomplete.");
  let veboComplete = true;
  const veboRequests = (await mapLimit(ranges, 3, async ({ start, end }) => {
    const logs = await optional(() => chain.rpc<Log[]>("eth_getLogs", [{
      address: addresses.vebo,
      topics: [VEBO_ABI.getEvent("ValidatorExitRequest")!.topicHash],
      fromBlock: hex(start), toBlock: hex(end),
    }]));
    if (!logs) { veboComplete = false; return []; }
    return logs.flatMap((log) => {
      try { return [parseVeboExitRequest(log)]; }
      catch { veboComplete = false; return []; }
    });
  })).flat().sort((a, b) => b.block - a.block);
  if (!veboComplete) warnings.push("Some VEBO exit request ranges could not be loaded; exit request totals are incomplete.");
  const ordered = [...candidates.values()].sort((a, b) => b.block - a.block);
  const limit = 120;
  const transactions = (await mapLimit(ordered.slice(0, limit), 4, async (candidate) => {
    try {
      const [tx, receipt, mined] = await Promise.all([
        chain.rpc<Tx>("eth_getTransactionByHash", [candidate.hash]),
        chain.rpc<Receipt>("eth_getTransactionReceipt", [candidate.hash]),
        chain.block(candidate.block),
      ]);
      const modules = receipt.logs.flatMap((log) => {
        if (log.address.toLowerCase() !== addresses.router.toLowerCase()) return [];
        try { const event = ROUTER_ABI.parseLog(log); return event?.name === "StakingRouterETHDeposited" ? [Number(event.args[0])] : []; } catch { return []; }
      });
      return {
        hash: candidate.hash, block: candidate.block, timestamp: num(mined.timestamp),
        from: tx.from, to: tx.to, kind: candidate.kind,
        status: num(receipt.status) === 1 ? "success" : "failed",
        amount: unbufferedAmount(receipt.logs, addresses.lido), modules: [...new Set(modules)],
        gasUsed: BigInt(receipt.gasUsed).toString(),
        gasCost: ethAmount((BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? tx.gasPrice)).toString()),
      } satisfies DepositorTransaction;
    } catch { warnings.push("Some transaction details could not be loaded."); return null; }
  })).filter((tx): tx is DepositorTransaction => tx !== null);
  // Sample actual historical state, using each sample's block timestamp. Missing
  // archive state creates a gap instead of a fabricated zero or interpolated value.
  const history = (await mapLimit(Array.from({ length: 13 }, (_, i) => Math.max(0, block - (12 - i) * 600)), 2, async (sample) => {
    for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [mined, buffer, depositable, demand] = await Promise.all([
        chain.block(sample),
        chain.call(addresses.lido, LIDO_ABI, "getBufferedEther", [], sample),
        chain.call(addresses.lido, LIDO_ABI, "getDepositableEther", [], sample),
        optional<bigint>(() => chain.call(addresses.withdrawalQueue, WITHDRAWAL_ABI, "unfinalizedStETH", [], sample)),
      ]);
      return { timestamp: num(mined.timestamp), buffer: ethAmount(String(buffer)), depositable: ethAmount(String(depositable)), withdrawalDemand: demand === null ? null : ethAmount(String(demand)) };
    } catch { if (attempt === 1) warnings.push("Some historical buffer samples are unavailable."); }
    }
    return null;
  })).filter((point): point is NonNullable<typeof point> => point !== null);
  if (history.some((point) => point.withdrawalDemand === null)) warnings.push("Some historical withdrawal demand samples are unavailable.");
  const start = await chain.block(from);
  return { history, transactions, withdrawals, withdrawalsComplete, veboRequests, veboComplete, activityFrom: num(start.timestamp), activityTo: block, activityTruncated: ordered.length > limit, warnings: [...new Set(warnings)] };
}

async function load(network: Network): Promise<DepositorSnapshot> {
  const chain = new Chain(network);
  const config = CONFIG[network];
  if (num(await chain.rpc<string>("eth_chainId", [])) !== config.chainId) throw new Error("RPC network mismatch");
  // Pin every state read to the same confirmed block.
  const head = await chain.block("latest");
  const block = Math.max(0, num(head.number) - 2);
  const mined = await chain.block(block);
  const [lido, dsm, router, gatewayResult, withdrawalQueue, vebo] = await Promise.all([
    chain.call(config.locator, LOCATOR_ABI, "lido", [], block) as Promise<string>,
    chain.call(config.locator, LOCATOR_ABI, "depositSecurityModule", [], block) as Promise<string>,
    chain.call(config.locator, LOCATOR_ABI, "stakingRouter", [], block) as Promise<string>,
    optional<string>(() => chain.call(config.locator, LOCATOR_ABI, "topUpGateway", [], block)),
    chain.call(config.locator, LOCATOR_ABI, "withdrawalQueue", [], block) as Promise<string>,
    chain.call(config.locator, LOCATOR_ABI, "validatorsExitBusOracle", [], block) as Promise<string>,
  ]);
  const gateway = gatewayResult && isAddress(gatewayResult) && gatewayResult !== ZERO ? gatewayResult : null;
  const addresses = { locator: config.locator, lido, dsm, gateway, router, withdrawalQueue, vebo };
  const [demand, pendingRequests, claimableEther, lastRequestId, lastFinalizedRequestId, paused, bunker] = await Promise.all([
    optional<bigint>(() => chain.call(withdrawalQueue, WITHDRAWAL_ABI, "unfinalizedStETH", [], block)),
    optional<bigint>(() => chain.call(withdrawalQueue, WITHDRAWAL_ABI, "unfinalizedRequestNumber", [], block)),
    optional<bigint>(() => chain.call(withdrawalQueue, WITHDRAWAL_ABI, "getLockedEtherAmount", [], block)),
    optional<bigint>(() => chain.call(withdrawalQueue, WITHDRAWAL_ABI, "getLastRequestId", [], block)),
    optional<bigint>(() => chain.call(withdrawalQueue, WITHDRAWAL_ABI, "getLastFinalizedRequestId", [], block)),
    optional<boolean>(() => chain.call(withdrawalQueue, WITHDRAWAL_ABI, "isPaused", [], block)),
    optional<boolean>(() => chain.call(withdrawalQueue, WITHDRAWAL_ABI, "isBunkerModeActive", [], block)),
  ]);
  const [buffer, depositable, total, canDeposit, depositsPaused, topupPaused, topupDistancePassed, lastDepositBlock, lastTopup, holderCount] = await Promise.all([
    chain.call(lido, LIDO_ABI, "getBufferedEther", [], block),
    chain.call(lido, LIDO_ABI, "getDepositableEther", [], block),
    chain.call(lido, LIDO_ABI, "getTotalPooledEther", [], block),
    optional<boolean>(() => chain.call(lido, LIDO_ABI, "canDeposit", [], block)),
    optional<boolean>(() => chain.call(dsm, DSM_ABI, "isDepositsPaused", [], block)),
    gateway ? optional<boolean>(() => chain.call(gateway, GATEWAY_ABI, "isPaused", [], block)) : null,
    gateway ? optional<boolean>(() => chain.call(gateway, GATEWAY_ABI, "isBlockDistancePassed", [], block)) : null,
    optional<bigint>(() => chain.call(dsm, DSM_ABI, "getLastDepositBlock", [], block)),
    gateway ? optional<bigint>(() => chain.call(gateway, GATEWAY_ABI, "getLastTopUpTimestamp", [], block)) : null,
    gateway ? optional<bigint>(() => chain.call(gateway, GATEWAY_ABI, "getRoleMemberCount", [id("TOP_UP_ROLE")], block)) : null,
  ]);
  const wallets = gateway && holderCount !== null ? await mapLimit(Array.from({ length: Math.min(Number(holderCount), 20) }, (_, i) => i), 3, async (i) => {
    const holder = await chain.call(gateway, GATEWAY_ABI, "getRoleMember", [id("TOP_UP_ROLE"), i], block) as string;
    return wallet(chain, holder, block);
  }) : [];
  const depositMined = lastDepositBlock ? await optional(() => chain.block(Number(lastDepositBlock))) : null;
  let cached = details.get(network);
  if (!cached || cached.expires < Date.now()) {
    const promise = loadDetails(chain, block, addresses);
    cached = { expires: Date.now() + 300_000, promise }; details.set(network, cached);
    void promise.catch(() => details.delete(network));
  }
  const activity = await cached.promise;
  if (activity.warnings.length) cached.expires = Math.min(cached.expires, Date.now() + 60_000);
  const warnings = [...activity.warnings];
  if ([demand, pendingRequests, claimableEther, lastRequestId, lastFinalizedRequestId, paused, bunker].some((value) => value === null)) warnings.push("Some withdrawal queue information is currently unavailable.");
  if (holderCount === null) warnings.push("Could not discover TOP_UP_ROLE holders from the current gateway.");
  if (holderCount !== null && holderCount > BigInt(20)) warnings.push("Only the first 20 role holders are shown.");
  if (num(head.timestamp) < Date.now() / 1000 - 300) warnings.push("The RPC chain head is more than five minutes old.");
  return {
    network, chainId: config.chainId, explorer: config.explorer, updatedAt: Math.floor(Date.now() / 1000),
    block, blockTimestamp: num(mined.timestamp), addresses, wallets,
    withdrawalQueue: {
      demand: demand === null ? null : ethAmount(String(demand)),
      pendingRequests: pendingRequests === null ? null : Number(pendingRequests),
      claimableEther: claimableEther === null ? null : ethAmount(String(claimableEther)),
      lastRequestId: lastRequestId === null ? null : String(lastRequestId),
      lastFinalizedRequestId: lastFinalizedRequestId === null ? null : String(lastFinalizedRequestId),
      paused, bunker,
    },
    amounts: { buffer: ethAmount(String(buffer)), depositable: ethAmount(String(depositable)), total: ethAmount(String(total)) },
    gates: { canDeposit, depositsPaused, topupPaused, topupDistancePassed },
    lastDeposit: lastDepositBlock && depositMined ? { block: Number(lastDepositBlock), timestamp: num(depositMined.timestamp) } : null,
    lastTopup: lastTopup ? Number(lastTopup) : null,
    ...activity, warnings,
  };
}

export async function GET(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get("network") ?? "mainnet";
  if (requested !== "mainnet" && requested !== "hoodi") return NextResponse.json({ error: "Choose mainnet or hoodi." }, { status: 400 });
  let cached = snapshots.get(requested);
  if (!cached || cached.expires < Date.now()) {
    const promise = load(requested);
    cached = { expires: Date.now() + 60_000, promise }; snapshots.set(requested, cached);
    void promise.catch(() => snapshots.delete(requested));
  }
  try {
    return NextResponse.json(await cached.promise, { headers: { "Cache-Control": "public, max-age=30, s-maxage=60" } });
  } catch {
    return NextResponse.json({ error: "Live Ethereum data is temporarily unavailable. Please retry shortly." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
