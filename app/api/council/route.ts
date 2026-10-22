import { NextRequest, NextResponse } from "next/server";
import { Interface, formatEther } from "ethers";
import {
  COUNCIL_BUS, COUNCIL_BUS_ABI, COUNCIL_CHAINS, COUNCIL_DSM, COUNCIL_EDF,
  COUNCIL_LABELS, COUNCIL_LOCATOR, parseCouncilBus, decodeCouncilDsm, CouncilStatistics,
  type CouncilChain, type CouncilKind, type CouncilLog, type CouncilGuardian, type CouncilSnapshot, type CouncilActivity, type CouncilEvent, type CouncilHead,
} from "../../council-data";
import { serverRpcs, parseRpcList } from "../../rpc-config";
import { blockAtOrBefore } from "../../depositor-history";

const CHAINS = Object.keys(COUNCIL_CHAINS) as CouncilChain[];
const hex = (n: number) => `0x${n.toString(16)}`;
const integer = (value: string) => Number(BigInt(value));
const ZERO = "0x0000000000000000000000000000000000000000";
const LOCATOR = new Interface(["function depositSecurityModule() view returns(address)"]);
type Block = { number: string; timestamp: string };
type Tx = { to: string | null; from: string; input: string; blockNumber: string };
type Receipt = { status: string; gasUsed: string; effectiveGasPrice: string; logs: CouncilLog[] };
const endpointLists = (chain: CouncilChain): readonly string[] => chain === "ethereum" ? serverRpcs("mainnet") : chain === "gnosis"
  ? parseRpcList(process.env.GNOSIS_RPC_URLS, ["https://rpc.gnosischain.com", "https://gnosis-rpc.publicnode.com"])
  : parseRpcList(process.env.POLYGON_RPC_URLS, ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"]);

async function optional<T>(read: () => Promise<T>): Promise<T | null> { try { return await read(); } catch { return null; } }
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => { while (cursor < items.length) { const i = cursor++; result[i] = await run(items[i]); } }));
  return result;
}
class Chain {
  chain: CouncilChain;
  blocks = new Map<number, Promise<CouncilHead>>();
  constructor(chain: CouncilChain) { this.chain = chain; }
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    for (const url of endpointLists(this.chain).slice(0, 3)) {
      try {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }), signal: AbortSignal.timeout(8000), cache: "no-store" });
        if (!response.ok) continue;
        const body = await response.json() as { result?: T; error?: unknown };
        if (!body.error && body.result !== undefined && body.result !== null) return body.result;
      } catch { /* Try another public provider without exposing configured URLs. */ }
    }
    throw new Error(`${COUNCIL_CHAINS[this.chain].name} ${method} unavailable`);
  }
  async call(address: string, abi: Interface, method: string, args: unknown[], block: number) {
    const data = await this.rpc<string>("eth_call", [{ to: address, data: abi.encodeFunctionData(method, args) }, hex(block)]);
    return abi.decodeFunctionResult(method, data)[0];
  }
  block(number: number): Promise<CouncilHead> {
    let promise = this.blocks.get(number);
    if (!promise) {
      promise = this.rpc<Block>("eth_getBlockByNumber", [hex(number), false]).then(b => ({ block: integer(b.number), timestamp: integer(b.timestamp) })).catch(error => { this.blocks.delete(number); throw error; });
      this.blocks.set(number, promise);
    }
    return promise;
  }
  async head() {
    if (integer(await this.rpc<string>("eth_chainId", [])) !== COUNCIL_CHAINS[this.chain].chainId) throw new Error("Council RPC chain mismatch");
    const latest = integer(await this.rpc<string>("eth_blockNumber", []));
    return this.block(Math.max(0, latest - 2));
  }
  async startAt(timestamp: number, head: CouncilHead) {
    let lower = await this.block(Math.max(0, head.block - Math.ceil(9 * 86400 / COUNCIL_CHAINS[this.chain].seconds)));
    if (lower.timestamp > timestamp) lower = await this.block(0);
    return blockAtOrBefore(timestamp, { number: lower.block, timestamp: lower.timestamp }, { number: head.block, timestamp: head.timestamp }, async number => {
      const b = await this.block(number); return { number: b.block, timestamp: b.timestamp };
    });
  }
  async logs(address: string | string[], topics: string[][], from: number, to: number, consume?: (logs: CouncilLog[]) => Promise<void>) {
    let complete = true;
    const ranges: { from: number; to: number }[] = [];
    for (let start = from; start <= to; start += 9000) ranges.push({ from: start, to: Math.min(start + 8999, to) });
    const groups = await mapLimit(ranges, 3, async range => {
      const records = await optional(() => this.rpc<CouncilLog[]>("eth_getLogs", [{ address, topics, fromBlock: hex(range.from), toBlock: hex(range.to) }]));
      if (!records) { complete = false; return []; }
      if (consume) { await consume(records); return []; }
      return records;
    });
    return { records: groups.flat(), complete };
  }
}

let summaryCache: { expires: number; promise: Promise<CouncilSnapshot> } | undefined;
let activityCache: { expires: number; promise: Promise<CouncilActivity>; dsm: string; members: string } | undefined;
type RawMessage = { log: CouncilLog; event: CouncilEvent };
let busHistoryCache: {
  key: string; stats: CouncilStatistics; heads: Partial<Record<CouncilChain, CouncilHead>>;
  recent: Record<string, RawMessage[]>; latestRaw: Map<string, RawMessage>;
} | undefined;
async function loadSnapshot(): Promise<CouncilSnapshot> {
  const clients = Object.fromEntries(CHAINS.map(chain => [chain, new Chain(chain)])) as Record<CouncilChain, Chain>;
  const headList = await Promise.all(CHAINS.map(chain => optional(() => clients[chain].head())));
  const heads: CouncilSnapshot["heads"] = {};
  const warnings: string[] = [];
  CHAINS.forEach((chain, i) => {
    const head = headList[i];
    if (head) { heads[chain] = head; if (head.timestamp < Date.now() / 1000 - 300) warnings.push(`${COUNCIL_CHAINS[chain].name} chain head is stale.`); }
    else warnings.push(`${COUNCIL_CHAINS[chain].name} balances are currently unavailable.`);
  });
  const eth = clients.ethereum, head = heads.ethereum;
  if (!head) throw new Error("Ethereum Council membership could not be read. Try Refresh.");
  const dsm = String(await eth.call(COUNCIL_LOCATOR, LOCATOR, "depositSecurityModule", [], head.block));
  const [addresses, quorum, paused, lastDepositBlock, validity, maxOperators] = await Promise.all([
    eth.call(dsm, COUNCIL_DSM, "getGuardians", [], head.block) as Promise<string[]>,
    eth.call(dsm, COUNCIL_DSM, "getGuardianQuorum", [], head.block),
    eth.call(dsm, COUNCIL_DSM, "isDepositsPaused", [], head.block),
    optional(() => eth.call(dsm, COUNCIL_DSM, "getLastDepositBlock", [], head.block)),
    optional(() => eth.call(dsm, COUNCIL_DSM, "getPauseIntentValidityPeriodBlocks", [], head.block)),
    optional(() => eth.call(dsm, COUNCIL_DSM, "getMaxOperatorsPerUnvetting", [], head.block)),
  ]);
  const guardians = await mapLimit(addresses, 3, async (address): Promise<CouncilGuardian> => {
    const [delegate, owner, terminated, pending] = await Promise.all([
      optional(() => eth.call(address, COUNCIL_EDF, "getDelegate", [], head.block) as Promise<string>),
      optional(() => eth.call(address, COUNCIL_EDF, "owner", [], head.block) as Promise<string>),
      optional(() => eth.call(address, COUNCIL_EDF, "isTerminated", [], head.block) as Promise<boolean>),
      optional(async () => {
        const encoded = await eth.rpc<string>("eth_call", [{ to: address, data: COUNCIL_EDF.encodeFunctionData("getPendingDelegate") }, hex(head.block)]);
        const value = COUNCIL_EDF.decodeFunctionResult("getPendingDelegate", encoded);
        return { address: String(value[0]), from: Number(value[1]) };
      }),
    ]);
    let wallet = delegate && delegate !== ZERO ? delegate : null;
    if (delegate === null) {
      const code = await optional(() => eth.rpc<string>("eth_getCode", [address, hex(head.block)]));
      if (code === "0x") wallet = address;
      else warnings.push(`Could not resolve the active wallet for guardian ${address}.`);
    }
    const balances = Object.fromEntries(await Promise.all(CHAINS.map(async chain => {
      const chainHead = heads[chain];
      const balance = wallet && chainHead ? await optional(() => clients[chain].rpc<string>("eth_getBalance", [wallet, hex(chainHead.block)])) : null;
      if (balance === null && wallet && chainHead) warnings.push(`Some ${COUNCIL_CHAINS[chain].name} wallet balances are unavailable.`);
      return [chain, balance === null ? null : formatEther(BigInt(balance))];
    }))) as CouncilGuardian["balances"];
    const label = COUNCIL_LABELS[address.toLowerCase()];
    return { address: address.toLowerCase(), name: label?.name ?? `Guardian ${addresses.indexOf(address) + 1}`, wallet: wallet?.toLowerCase() ?? null, owner: owner?.toLowerCase() ?? null, terminated, pendingDelegate: pending && pending.address !== ZERO ? pending.address.toLowerCase() : null, pendingFrom: pending?.from ?? null, legacy: label?.legacy ?? null, balances };
  });
  const lastDeposit = lastDepositBlock && Number(lastDepositBlock) > 0 ? await optional(() => eth.block(Number(lastDepositBlock))) : null;
  return { updatedAt: Math.floor(Date.now() / 1000), dsm, quorum: Number(quorum), paused: Boolean(paused), guardians, heads, lastDeposit, pauseValidityBlocks: validity === null ? null : Number(validity), maxOperatorsPerUnvet: maxOperators === null ? null : Number(maxOperators), warnings: [...new Set(warnings)] };
}
function snapshot() {
  if (!summaryCache || summaryCache.expires < Date.now()) {
    const promise = loadSnapshot(); summaryCache = { expires: Date.now() + 60_000, promise };
    void promise.catch(() => { summaryCache = undefined; });
  }
  return summaryCache.promise;
}

type IndexItem = { hash?: string; transaction_hash?: string; timestamp?: string; block_number?: number; type?: string; to?: { hash: string } };
async function indexedDsmCalls(dsm: string, from: number, toBlock: number) {
  const hashes = new Set<string>(); let complete = true;
  for (const feed of ["transactions?filter=to", "internal-transactions"]) {
    let url: string | null = `https://eth.blockscout.com/api/v2/addresses/${dsm}/${feed}`;
    for (let page = 0; url && page < 12; page++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(12000), cache: "no-store" });
        if (!response.ok) throw new Error("DSM transaction index unavailable");
        const body = await response.json() as { items: IndexItem[]; next_page_params?: Record<string, string | number> | null };
        if (!Array.isArray(body.items)) throw new Error("DSM index format unavailable");
        let reachedStart = false;
        for (const item of body.items) {
          const time = item.timestamp ? Date.parse(item.timestamp) / 1000 : null;
          if (time !== null && time < from) { reachedStart = true; continue; }
          if (item.block_number !== undefined && item.block_number > toBlock) continue;
          if (feed.startsWith("internal") && (item.type !== "call" || item.to?.hash.toLowerCase() !== dsm.toLowerCase())) continue;
          const hash = item.transaction_hash ?? item.hash; if (hash) hashes.add(hash);
        }
        if (reachedStart || !body.next_page_params) url = null;
        else {
          const params = new URLSearchParams(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)]));
          if (feed.startsWith("transactions")) params.set("filter", "to");
          url = `https://eth.blockscout.com/api/v2/addresses/${dsm}/${feed.split("?")[0]}?${params}`;
        }
      } catch { complete = false; url = null; }
      if (page === 11 && url) complete = false;
    }
  }
  return { hashes, complete };
}

async function loadActivity(state: CouncilSnapshot): Promise<CouncilActivity> {
  const now = Math.min(state.updatedAt, state.heads.ethereum!.timestamp);
  const from = Math.floor(now / 86400) * 86400 - 6 * 86400;
  const warnings: string[] = [];
  const coverage: CouncilActivity["coverage"] = { ethereum: false, gnosis: false, polygon: false };
  const aliases = new Map<string, CouncilGuardian>();
  for (const guardian of state.guardians) {
    for (const address of [guardian.address, guardian.wallet, guardian.legacy]) if (address) aliases.set(address.toLowerCase(), guardian);
  }
  const ethereum = new Chain("ethereum"), head = state.heads.ethereum!;
  const first = await ethereum.startAt(from, head);
  // Include keys effective at the start and nominations/revocations during
  // the window. These never qualify as current-key health observations.
  const historicalKeys = await Promise.all(state.guardians.map(async g => {
    const key = await optional(() => ethereum.call(g.address, COUNCIL_EDF, "getDelegate", [], first) as Promise<string>);
    if (key && key !== ZERO) aliases.set(key.toLowerCase(), g);
    return key;
  }));
  const rotations = await ethereum.logs(state.guardians.map(g => g.address), [[COUNCIL_EDF.getEvent("DelegateNominated")!.topicHash, COUNCIL_EDF.getEvent("DelegateRevoked")!.topicHash]], first, head.block);
  let aliasesComplete = rotations.complete && historicalKeys.every(key => key !== null);
  for (const log of rotations.records) {
    try {
      const event = COUNCIL_EDF.parseLog(log), g = aliases.get(log.address.toLowerCase());
      if (event && g) aliases.set(String(event.args[0]).toLowerCase(), g);
    } catch { aliasesComplete = false; }
  }
  if (!aliasesComplete) warnings.push("Some delegate-rotation history is unavailable; historical message attribution may be incomplete.");
  const cacheKey = `${from}:${state.dsm}:${state.guardians.map(g => `${g.address}:${g.wallet}`).join(",")}`;
  const previous = busHistoryCache?.key === cacheKey && now >= busHistoryCache.stats.to && (["gnosis", "polygon"] as const).every(chain => state.heads[chain] && busHistoryCache!.heads[chain] && state.heads[chain]!.block >= busHistoryCache!.heads[chain]!.block) ? busHistoryCache : undefined;
  const scannedHeads = structuredClone(state.heads);
  const stats = new CouncilStatistics(state.guardians, now);
  if (previous) { Object.assign(stats, structuredClone(previous.stats)); stats.to = now; }
  const eventKinds = new Map(COUNCIL_BUS_ABI.fragments.filter(f => f.type === "event").map(f => {
    const event = COUNCIL_BUS_ABI.getEvent(f.format())!;
    const kind: CouncilKind = event.name.startsWith("MessageDeposit") ? "deposit" : event.name.startsWith("MessagePing") ? "ping" : event.name.startsWith("MessagePause") ? "pause" : "unvet";
    return [event.topicHash, kind] as const;
  }));
  const recent: Record<string, RawMessage[]> = previous ? Object.fromEntries(Object.entries(previous.recent).map(([kind, records]) => [kind, [...records]])) : { deposit: [], ping: [], pause: [], unvet: [] };
  const latestRaw = new Map<string, RawMessage>(previous?.latestRaw);
  const limits: Record<string, number> = { deposit: 300, ping: 150, pause: 25, unvet: 25 };
  await Promise.all((["gnosis", "polygon"] as const).map(async chain => {
    const client = new Chain(chain), head = state.heads[chain];
    if (!head) { warnings.push(`${COUNCIL_CHAINS[chain].name} message history is unavailable.`); return; }
    try {
      // Do not checkpoint later blocks whose messages fall beyond the common
      // Ethereum cutoff; those records must remain eligible on the next scan.
      const toBlock = head.timestamp > now ? await client.startAt(now, head) : head.block;
      scannedHeads[chain] = await client.block(toBlock);
      const first = previous?.heads[chain] ? previous.heads[chain]!.block + 1 : await client.startAt(from, head);
      let decodedComplete = true;
      const logs = await client.logs(COUNCIL_BUS, [[...eventKinds.keys()]], first, toBlock, async records => {
        const batch: Record<string, RawMessage[]> = { deposit: [], ping: [], pause: [], unvet: [] };
        for (const log of records) {
          try {
            const sender = `0x${log.topics[1]?.slice(-40)}`.toLowerCase();
            const guardian = aliases.get(sender), kind = eventKinds.get(log.topics[0]);
            if (!guardian || !kind) continue;
            const timestamp = log.blockTimestamp ? integer(log.blockTimestamp) : (await client.block(integer(log.blockNumber))).timestamp;
            const event: CouncilEvent = { id: `${chain}:${log.transactionHash}:${log.logIndex}`, chain, stage: "message", kind, hash: log.transactionHash, block: integer(log.blockNumber), timestamp, sender, guardian: guardian.address, guardians: [guardian.address], currentKey: sender === guardian.wallet, moduleId: null, referenceBlock: null, version: null, success: true, payload: {} };
            if (!stats.add(event)) continue;
            const candidate = { log, event };
            batch[kind].push(candidate);
            const key = `${guardian.address}:${event.currentKey ? "current" : "other"}`;
            if (!latestRaw.has(key) || latestRaw.get(key)!.event.timestamp < timestamp) latestRaw.set(key, candidate);
          } catch { decodedComplete = false; }
        }
        for (const kind of Object.keys(batch)) recent[kind] = [...recent[kind], ...batch[kind]].sort((a,b) => b.event.timestamp - a.event.timestamp || b.event.block - a.event.block).slice(0, limits[kind]);
      });
      coverage[chain] = logs.complete && decodedComplete && aliasesComplete;
      if (!coverage[chain]) warnings.push(`Some ${COUNCIL_CHAINS[chain].name} DataBus ranges could not be read; message counts are lower bounds.`);
    } catch { warnings.push(`${COUNCIL_CHAINS[chain].name} DataBus history could not be loaded.`); }
  }));
  const raw = new Map([...Object.values(recent).flat(), ...latestRaw.values()].map(item => [item.event.id,item]));
  const decodedMessages = new Map<string, CouncilEvent>();
  for (const { log, event } of raw.values()) {
    try {
      decodedMessages.set(event.id, { ...parseCouncilBus(log,event.chain,event.timestamp), guardian: event.guardian, guardians: event.guardians, currentKey: event.currentKey });
    } catch {
      coverage[event.chain] = false;
      decodedMessages.set(event.id, { ...event, payload: { error: "Payload could not be decoded; counted by its published event identifier." } });
      warnings.push("Some Council payloads could not be decoded; broadcasts are counted by their event identifier.");
    }
  }
  for (const member of stats.members) {
    if (member.last) member.last = decodedMessages.get(member.last.id) ?? member.last;
    if (member.lastCurrent) member.lastCurrent = decodedMessages.get(member.lastCurrent.id) ?? member.lastCurrent;
  }
  // Keep only a complete bus checkpoint. A failed tail is retried from the
  // previous complete head, without double-counting partially loaded ranges.
  // A new UTC window or delegate rotation automatically starts a fresh scan.
  if (coverage.gnosis && coverage.polygon) busHistoryCache = { key: cacheKey, stats: Object.assign(new CouncilStatistics(state.guardians, now), structuredClone(stats)), heads: scannedHeads, recent, latestRaw };
  const dsmTopics = ["DepositsPaused", "DepositsUnpaused", "LastDepositBlockChanged"].map(name => COUNCIL_DSM.getEvent(name)!.topicHash);
  const [logs, index] = await Promise.all([
    ethereum.logs(state.dsm, [dsmTopics], first, head.block),
    indexedDsmCalls(state.dsm, from, head.block),
  ]);
  coverage.ethereum = logs.complete;
  if (!logs.complete) warnings.push("Some DSM event ranges are unavailable; execution counts are lower bounds.");
  if (!index.complete) warnings.push("DSM transaction history is incomplete. Pauses and deposits also use contract events; unvet calls depend on the transaction index.");
  for (const log of logs.records) index.hashes.add(log.transactionHash);
  let detailsComplete = true;
  const executions = (await mapLimit([...index.hashes], 4, async hash => {
    try {
      const tx = await ethereum.rpc<Tx>("eth_getTransactionByHash", [hash]);
      const decoded = decodeCouncilDsm(tx, state.dsm);
      const knownLogs = logs.records.filter(log => log.transactionHash === hash);
      if (!decoded && !knownLogs.length) return null;
      const [receipt, block] = await Promise.all([ethereum.rpc<Receipt>("eth_getTransactionReceipt", [hash]), ethereum.block(integer(tx.blockNumber))]);
      if (block.block > head.block || block.timestamp < from) return null;
      const stateEvent = knownLogs.map(log => COUNCIL_DSM.parseLog(log)).find(event => event?.name === "DepositsPaused" || event?.name === "LastDepositBlockChanged" || event?.name === "DepositsUnpaused");
      const kind = decoded?.kind ?? (stateEvent?.name === "DepositsPaused" ? "pause" : stateEvent?.name === "DepositsUnpaused" ? "resume" : "deposit");
      const rawGuardian = stateEvent?.name === "DepositsPaused" ? String(stateEvent.args.guardian).toLowerCase() : decoded?.guardian;
      const guardian = rawGuardian ? aliases.get(rawGuardian)?.address ?? null : null;
      const attesters = (decoded?.guardians ?? []).map(address => aliases.get(address)?.address).filter((a): a is string => !!a);
      return {
        id: `ethereum:${hash}:execution`, chain: "ethereum", stage: "execution", kind, hash,
        block: block.block, timestamp: block.timestamp, sender: tx.from.toLowerCase(),
        guardian: kind === "deposit" ? null : guardian, guardians: [...new Set(attesters)], currentKey: false,
        moduleId: decoded?.moduleId ?? null, referenceBlock: decoded?.referenceBlock ?? null, version: null,
        success: integer(receipt.status) === 1,
        payload: { ...decoded?.payload, ...(stateEvent ? { stateEvent: stateEvent.name } : {}), gasUsed: String(BigInt(receipt.gasUsed)), gasCostETH: formatEther(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)), ...(kind === "pause" ? { pausedStateChanged: stateEvent?.name === "DepositsPaused" } : {}) },
      } satisfies CouncilEvent;
    } catch { detailsComplete = false; return null; }
  })).filter((e): e is NonNullable<typeof e> => e !== null);
  if (!detailsComplete) warnings.push("Some DSM transaction details could not be verified; execution counts are lower bounds.");
  for (const event of executions) stats.add(event);
  const retainedIds = new Set(Object.values(recent).flat().map(item => item.event.id));
  const retained = [...decodedMessages.values()].filter(event => retainedIds.has(event.id));
  const events = [...retained, ...executions.sort((a,b) => b.timestamp - a.timestamp).slice(0,100)].sort((a,b) => b.timestamp - a.timestamp || b.block - a.block);
  return { ...stats.finish(events), updatedAt: Math.floor(Date.now() / 1000), coverage, dsmHistoryComplete: logs.complete && index.complete && detailsComplete, warnings: [...new Set(warnings)] };
}

export async function GET(request: NextRequest) {
  try {
    const state = await snapshot();
    if (request.nextUrl.searchParams.get("section") !== "activity") return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
    const members = state.guardians.map(g => `${g.address}:${g.wallet}`).join(",");
    if (!activityCache || activityCache.expires < Date.now() || activityCache.dsm !== state.dsm || activityCache.members !== members) {
      const promise = loadActivity(state); activityCache = { promise, expires: Date.now() + 300_000, dsm: state.dsm, members };
      void promise.catch(() => { activityCache = undefined; });
    }
    const data = await activityCache.promise;
    if (data.warnings.length) activityCache!.expires = Math.min(activityCache!.expires, Date.now() + 60_000);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Council chain data could not be read. Try Refresh; the public RPC or transaction index may be temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
