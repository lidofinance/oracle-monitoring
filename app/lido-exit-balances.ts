import { promises as fs } from "node:fs";
import path from "node:path";
import { dailySnapshotTimes } from "./depositor-history";
import { parseRpcList } from "./rpc-config";
import { beaconUint, EXITING_STATUSES, sumLidoExitBalances, type ExitingValidator, type LidoExitBalanceHistory, type LidoExitBalancePoint } from "./lido-exit-balances-data";

type Network = LidoExitBalanceHistory["network"];
const CONFIG = {
  mainnet: { chainId: 1, genesisRoot: "0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95", kapi: "https://keys-api.lido.fi", publicBeacon: "https://ethereum-beacon-api.publicnode.com", archive: "http://hr6vb81d1ndsx-cl-3-mainnet-lighthouse.tooling-nodes.testnet.fi" },
  hoodi: { chainId: 560048, genesisRoot: "0x212f13fc4df078b6cb7db228f1c8307566dcecf900867401a92023d7ba99cb5f", kapi: "https://keys-api-hoodi.testnet.fi", publicBeacon: "https://ethereum-hoodi-beacon-api.publicnode.com", archive: "http://hr6vb81d1ndsx-cl-5-hoodi-lighthouse.tooling-nodes.testnet.fi" },
};
class SourceError extends Error { status: number; constructor(status: number) { super("Data source unavailable"); this.status = status; } }
async function json<T>(url: string, init: RequestInit = {}, timeout = 30_000): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout), cache: "no-store", headers: { accept: "application/json", ...init.headers } });
  if (!response.ok) throw new SourceError(response.status);
  return response.json() as Promise<T>;
}
type BeaconResponse<T> = { data: T; execution_optimistic: boolean };
const integer = (value: string) => { const n = Number(beaconUint(value)); if (!Number.isSafeInteger(n)) throw Error("Unsafe Beacon integer"); return n; };
const cacheFile = (network: Network) => path.join(process.env.LIDO_EXIT_BALANCE_CACHE_DIR ?? path.join(process.cwd(), ".cache", "lido-exit-balances"), `${network}.json`);
const jobs = new Map<Network, LidoExitBalanceHistory & { finished?: number }>();

async function collectPoint(network: Network, timestamp: number): Promise<LidoExitBalancePoint> {
  const cfg = CONFIG[network], now = Math.floor(Date.now() / 1000);
  const kapi = (network === "mainnet" ? process.env.MAINNET_KEYS_API_URL : process.env.HOODI_KEYS_API_URL) ?? cfg.kapi;
  const configured = parseRpcList(network === "mainnet" ? process.env.MAINNET_BEACON_URLS : process.env.HOODI_BEACON_URLS, [cfg.archive]);
  const historical = timestamp < Math.floor(now / 86400) * 86400;
  const providers = [...new Set(historical ? [...configured, cfg.publicBeacon] : [cfg.publicBeacon, ...configured])];
  const status = await json<{ chainId: number; elBlockSnapshot: { blockNumber: number } }>(`${kapi}/v1/status`);
  if (status.chainId !== cfg.chainId) throw Error("KAPI network mismatch");
  for (const base of providers) {
    const timeout = base === cfg.publicBeacon ? 20_000 : 180_000;
    const read = async <T>(suffix: string, verify = true): Promise<T> => {
      const body = await json<BeaconResponse<T>>(`${base}${suffix}`, {}, timeout);
      if (body.data === undefined || (verify && body.execution_optimistic !== false)) throw Error("Unverified Beacon state");
      return body.data;
    };
    try {
      const [genesis, spec] = await Promise.all([
        read<{ genesis_time: string; genesis_validators_root: string }>("/eth/v1/beacon/genesis", false),
        read<Record<string, string>>("/eth/v1/config/spec", false),
      ]);
      if (genesis.genesis_validators_root !== cfg.genesisRoot || integer(spec.DEPOSIT_CHAIN_ID) !== cfg.chainId) throw Error("Beacon network mismatch");
      const genesisTime = integer(genesis.genesis_time), secondsPerSlot = spec.SECONDS_PER_SLOT ? integer(spec.SECONDS_PER_SLOT) : integer(spec.SLOT_DURATION_MS) / 1000;
      const slotsPerEpoch = integer(spec.SLOTS_PER_EPOCH);
      if (!Number.isSafeInteger(secondsPerSlot) || secondsPerSlot <= 0 || slotsPerEpoch <= 0) throw Error("Invalid slot timing");
      const requestedSlot = Math.floor((timestamp - genesisTime) / secondsPerSlot);
      type Header = { root: string; canonical: boolean; header: { message: { slot: string; state_root: string } } };
      let header: Header | null = null;
      for (let slot = requestedSlot; slot >= requestedSlot - 32; slot--) {
        try { header = await read<Header>(`/eth/v1/beacon/headers/${slot}`); if (integer(header.header.message.slot) !== slot) throw Error("Wrong Beacon slot"); break; }
        catch (error) { if (!(error instanceof SourceError) || error.status !== 404) throw error; }
      }
      if (!header?.canonical || !/^0x[\da-f]{64}$/i.test(header.root) || !/^0x[\da-f]{64}$/i.test(header.header.message.state_root)) throw Error("Missing canonical Beacon block");
      const slot = integer(header.header.message.slot), root = header.header.message.state_root;
      const [records, consolidations, block] = await Promise.all([
        read<ExitingValidator[]>(`/eth/v1/beacon/states/${root}/validators?status=${EXITING_STATUSES.join(",")}`),
        read<{ source_index: string; target_index: string }[]>(`/eth/v1/beacon/states/${root}/pending_consolidations`),
        read<{ message: { body: { execution_payload: { block_number: string; timestamp: string } } } }>(`/eth/v2/beacon/blocks/${header.root}`),
      ]);
      const payload = block.message.body.execution_payload, blockNumber = integer(payload.block_number), beaconTimestamp = integer(payload.timestamp);
      if (status.elBlockSnapshot.blockNumber < blockNumber || beaconTimestamp > timestamp || timestamp - beaconTimestamp > 32 * secondsPerSlot || beaconTimestamp !== genesisTime + slot * secondsPerSlot) throw Error("Snapshot timing mismatch");
      if (!Array.isArray(records) || !Array.isArray(consolidations)) throw Error("Incomplete Beacon lists");
      // Exclude consolidation sources before querying membership: only a small
      // subset of the network registry needs KAPI lookups, not all 500k Lido keys.
      const sources = new Set(consolidations.map(c => { beaconUint(c.target_index); return beaconUint(c.source_index).toString(); }));
      const candidates = records.filter(v => !sources.has(beaconUint(v.index).toString()) && beaconUint(v.balance) > BigInt(0));
      const keys = new Set<string>();
      for (let i = 0; i < candidates.length; i += 200) {
        const pubkeys = candidates.slice(i, i + 200).map(v => v.validator.pubkey.toLowerCase());
        if (pubkeys.some(key => !/^0x[\da-f]{96}$/.test(key))) throw Error("Invalid Beacon key");
        const found = await json<{ data: { key: string; used: boolean }[]; meta: { elBlockSnapshot: { blockNumber: number } } }>(`${kapi}/v1/keys/find`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pubkeys }) });
        if (!Array.isArray(found.data) || !Number.isSafeInteger(found.meta?.elBlockSnapshot?.blockNumber) || found.meta.elBlockSnapshot.blockNumber < blockNumber) throw Error("Incomplete KAPI membership response");
        const requested = new Set(pubkeys);
        for (const key of found.data) {
          if (typeof key.key !== "string" || typeof key.used !== "boolean" || !requested.has(key.key.toLowerCase())) throw Error("Inconsistent KAPI membership");
          if (key.used) keys.add(key.key.toLowerCase());
        }
      }
      return { timestamp, beaconTimestamp, slot, status: "ready", ...sumLidoExitBalances(records, keys, consolidations, Math.floor(slot / slotsPerEpoch)) };
    } catch { /* Try another complete state; never mix Beacon roots or networks. */ }
  }
  throw Error("Historical Beacon exit balances unavailable");
}

async function collect(network: Network, job: LidoExitBalanceHistory & { finished?: number }) {
  let stored: LidoExitBalancePoint[] = [];
  try {
    const raw = JSON.parse(await fs.readFile(cacheFile(network), "utf8")) as { version: number; network: Network; points: LidoExitBalancePoint[] };
    if (raw.version === 1 && raw.network === network && Array.isArray(raw.points)) stored = raw.points;
  } catch { /* A cache miss does not change the meaning of unavailable data. */ }
  // Show the latest balance first, then backfill immutable UTC closes one at a
  // time to avoid overloading the archive node with state reconstructions.
  for (const index of [6, 5, 4, 3, 2, 1, 0]) {
    const timestamp = job.points[index].timestamp;
    const cached = index !== 6 ? stored.find(p => p.timestamp === timestamp && p.status === "ready" && p.balance !== null && p.validators !== null && p.slot !== null && p.beaconTimestamp !== null) : null;
    job.progress = `Lido exits · ${new Date(timestamp * 1000).toISOString().slice(0, 10)}${index === 6 ? " latest" : " UTC close"}`;
    try { job.points[index] = cached ?? await collectPoint(network, timestamp); }
    catch { job.points[index] = { timestamp, beaconTimestamp: null, slot: null, balance: null, validators: null, status: "unavailable" }; }
    job.updatedAt = Math.floor(Date.now() / 1000);
    try {
      const file = cacheFile(network); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const points = [...stored.filter(p => !job.points.some(n => n.timestamp === p.timestamp)), ...job.points.filter(p => p.status === "ready")].filter(p => p.timestamp >= job.points[0].timestamp).slice(-20);
      await fs.writeFile(`${file}.tmp`, JSON.stringify({ version: 1, network, points }), { mode: 0o600 }); await fs.rename(`${file}.tmp`, file);
    } catch { /* Optional disk caching must not invalidate a verified point. */ }
  }
  job.status = "ready"; job.progress = "Daily Lido exit balances collected"; job.finished = Date.now();
}

export function readLidoExitBalances(network: Network): LidoExitBalanceHistory {
  let job = jobs.get(network);
  const now = Math.floor(Date.now() / 1000);
  if (!job || (job.finished && (Date.now() - job.finished > (job.points.some(point=>point.status!=='ready')?15_000:300_000) || Math.floor(job.points[6].timestamp / 86400) !== Math.floor(now / 86400)))) {
    job = { network, status: "loading", progress: "Reading Lido exit balances", updatedAt: now, points: dailySnapshotTimes(now).map(timestamp => ({ timestamp, beaconTimestamp: null, slot: null, balance: null, validators: null, status: "loading" })) };
    jobs.set(network, job);
    void collect(network, job).catch(() => { job!.status = "ready"; job!.progress = "Lido exit balances unavailable"; job!.finished = Date.now(); });
  }
  return { network, status: job.status, progress: job.progress, points: job.points, updatedAt: job.updatedAt };
}
