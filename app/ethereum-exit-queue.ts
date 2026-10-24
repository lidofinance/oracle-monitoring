import { formatUnits } from "ethers";

export type ExitQueueNetwork = "mainnet" | "hoodi";
export type ExitQueueSnapshot = {
  network: ExitQueueNetwork;
  observedAt: number;
  fetchedAt: number;
  slot: number;
  epoch: number;
  stateRoot: string;
  validators: number;
  effectiveETH: string;
  slashedValidators: number;
  consolidationValidators: number;
  consolidationEffectiveETH: string;
  firstExitAt: number | null;
  lastExitAt: number | null;
  withdrawalDelaySeconds: number;
  source: { name: string; url: string | null };
};
export type ExitQueueResponse = {
  network: ExitQueueNetwork;
  status: "ready" | "stale" | "unavailable";
  snapshot: ExitQueueSnapshot | null;
  message?: string;
};
type BeaconValidator = {
  index: string;
  status: string;
  validator: {
    effective_balance: string;
    activation_epoch: string;
    exit_epoch: string;
    slashed: boolean;
  };
};
type PendingConsolidation = { source_index: string; target_index: string };
type BeaconResponse<T> = { data: T; execution_optimistic?: boolean };
type Header = { canonical: boolean; header: { message: { slot: string; state_root: string } } };
const GENESIS_ROOTS = {
  mainnet: "0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95",
  hoodi: "0x212f13fc4df078b6cb7db228f1c8307566dcecf900867401a92023d7ba99cb5f",
};
const PUBLIC_BEACONS = {
  mainnet: "https://ethereum-beacon-api.publicnode.com",
  hoodi: "https://ethereum-hoodi-beacon-api.publicnode.com",
};
const FAR_FUTURE_EPOCH = BigInt("18446744073709551615");
const uint = (value: string) => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid Beacon integer");
  const n = BigInt(value);
  if (n > FAR_FUTURE_EPOCH) throw new Error("Beacon integer overflow");
  return n;
};
const safeNumber = (value: string) => {
  const n = Number(uint(value));
  if (!Number.isSafeInteger(n)) throw new Error("Unsafe Beacon integer");
  return n;
};

/** Use assigned epochs and effective balances, including compounding validators.
 * Consolidations use separate churn, so they must not extend the ordinary exit ETA.
 * Sources: ethereum/beacon-APIs states/validators and pending_consolidations;
 * consensus-specs Electra initiate_validator_exit / process_consolidation_request.
 */
export function summarizeExitQueue(input: {
  network: ExitQueueNetwork;
  slot: number;
  stateRoot: string;
  genesisTime: number;
  secondsPerSlot: number;
  slotsPerEpoch: number;
  withdrawalDelayEpochs: number;
  validators: BeaconValidator[];
  consolidations: PendingConsolidation[];
  fetchedAt: number;
  source: ExitQueueSnapshot["source"];
}): ExitQueueSnapshot {
  for (const n of [input.slot, input.genesisTime, input.secondsPerSlot, input.slotsPerEpoch, input.withdrawalDelayEpochs, input.fetchedAt]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid Beacon timing");
  }
  if (!input.secondsPerSlot || !input.slotsPerEpoch || !input.withdrawalDelayEpochs) throw new Error("Missing Beacon timing");
  if (!Array.isArray(input.validators) || !Array.isArray(input.consolidations)) throw new Error("Incomplete Beacon lists");
  const epoch = Math.floor(input.slot / input.slotsPerEpoch);
  const epochSeconds = input.secondsPerSlot * input.slotsPerEpoch;
  const observedAt = input.genesisTime + input.slot * input.secondsPerSlot;
  if (input.fetchedAt - observedAt > 180 || observedAt - input.fetchedAt > input.secondsPerSlot) throw new Error("Stale Beacon head");
  const sources = new Set(input.consolidations.map(c => {
    uint(c.target_index);
    return uint(c.source_index).toString();
  }));
  let validators = 0, slashedValidators = 0, consolidationValidators = 0;
  let effective = BigInt(0), consolidationEffective = BigInt(0);
  let firstEpoch: number | null = null, lastEpoch: number | null = null;
  const seen = new Set<string>();
  for (const record of input.validators) {
    const index = uint(record.index).toString();
    const v = record.validator;
    const exit = uint(v.exit_epoch);
    const balance = uint(v.effective_balance);
    const activation = uint(v.activation_epoch);
    if (seen.has(index) || !["active_exiting", "active_slashed"].includes(record.status) ||
        typeof v.slashed !== "boolean" || v.slashed !== (record.status === "active_slashed") ||
        activation > BigInt(epoch) || exit <= BigInt(epoch) || exit === FAR_FUTURE_EPOCH) {
      throw new Error("Inconsistent exit registry response");
    }
    seen.add(index);
    // A slashed consolidation source exits through the ordinary withdrawal path.
    if (sources.has(index) && !v.slashed) {
      consolidationValidators++;
      consolidationEffective += balance;
      continue;
    }
    const exitEpoch = safeNumber(v.exit_epoch);
    validators++;
    if (v.slashed) slashedValidators++;
    effective += balance;
    firstEpoch = firstEpoch === null ? exitEpoch : Math.min(firstEpoch, exitEpoch);
    lastEpoch = lastEpoch === null ? exitEpoch : Math.max(lastEpoch, exitEpoch);
  }
  const epochTime = (e: number | null) => e === null ? null : input.genesisTime + e * epochSeconds;
  return {
    network: input.network, observedAt, fetchedAt: input.fetchedAt, slot: input.slot, epoch, stateRoot: input.stateRoot,
    validators, effectiveETH: formatUnits(effective, 9), slashedValidators,
    consolidationValidators, consolidationEffectiveETH: formatUnits(consolidationEffective, 9),
    firstExitAt: epochTime(firstEpoch), lastExitAt: epochTime(lastEpoch),
    withdrawalDelaySeconds: input.withdrawalDelayEpochs * epochSeconds,
    source: input.source,
  };
}

export async function collectExitQueue(network: ExitQueueNetwork, options: {
  endpoints?: readonly string[];
  fetcher?: typeof fetch;
  now?: () => number;
} = {}): Promise<ExitQueueSnapshot> {
  const configured = (network === "mainnet" ? process.env.MAINNET_BEACON_URLS : process.env.HOODI_BEACON_URLS)
    ?.split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean) ?? [];
  const endpoints = options.endpoints ?? [...new Set([PUBLIC_BEACONS[network], ...configured])].slice(0, 3);
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  for (const endpoint of endpoints) {
    // Bound the whole provider attempt, including all response bodies.
    const signal = AbortSignal.timeout(15_000);
    const read = async <T>(path: string, verifiedState = false): Promise<T> => {
      const response = await fetcher(`${endpoint}${path}`, { signal, cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("Beacon API unavailable");
      const body = await response.json() as BeaconResponse<T>;
      if (verifiedState && body.execution_optimistic !== false) throw new Error("Unverified Beacon state");
      if (body.data === undefined) throw new Error("Missing Beacon data");
      return body.data;
    };
    try {
      const [genesis, spec, header] = await Promise.all([
        read<{ genesis_time: string; genesis_validators_root: string }>("/eth/v1/beacon/genesis"),
        read<Record<string, string>>("/eth/v1/config/spec"),
        read<Header>("/eth/v1/beacon/headers/head", true),
      ]);
      if (genesis.genesis_validators_root !== GENESIS_ROOTS[network] ||
          safeNumber(spec.DEPOSIT_CHAIN_ID) !== (network === "mainnet" ? 1 : 560048)) throw new Error("Beacon network mismatch");
      const slot = safeNumber(header.header.message.slot), root = header.header.message.state_root;
      if (!header.canonical || !/^0x[\da-f]{64}$/i.test(root)) throw new Error("Invalid Beacon head");
      const [validators, consolidations] = await Promise.all([
        read<BeaconValidator[]>(`/eth/v1/beacon/states/${root}/validators?status=active_exiting,active_slashed`, true),
        read<PendingConsolidation[]>(`/eth/v1/beacon/states/${root}/pending_consolidations`, true),
      ]);
      return summarizeExitQueue({
        network, slot, stateRoot: root, genesisTime: safeNumber(genesis.genesis_time),
        secondsPerSlot: spec.SECONDS_PER_SLOT ? safeNumber(spec.SECONDS_PER_SLOT) : safeNumber(spec.SLOT_DURATION_MS) / 1000,
        slotsPerEpoch: safeNumber(spec.SLOTS_PER_EPOCH), withdrawalDelayEpochs: safeNumber(spec.MIN_VALIDATOR_WITHDRAWABILITY_DELAY),
        validators, consolidations, fetchedAt: now(),
        // Never publish credentials or private configured node URLs to browsers.
        source: endpoint === PUBLIC_BEACONS[network]
          ? { name: "PublicNode Beacon API", url: `${endpoint}/eth/v1/beacon/states/${root}/validators?status=active_exiting,active_slashed` }
          : { name: "Configured Beacon API", url: null },
      });
    } catch { /* Retry the complete pinned snapshot on the next provider. */ }
  }
  throw new Error("A complete, current Beacon exit queue is unavailable.");
}

/** Separate network caches; failures retain explicitly stale data for at most 15 minutes. */
export function createExitQueueReader(
  collect: (network: ExitQueueNetwork) => Promise<ExitQueueSnapshot> = collectExitQueue,
  now: () => number = () => Math.floor(Date.now() / 1000),
) {
  const cache = new Map<ExitQueueNetwork, { expires: number; last?: ExitQueueSnapshot; pending?: Promise<ExitQueueResponse>; result?: ExitQueueResponse }>();
  return async (network: ExitQueueNetwork): Promise<ExitQueueResponse> => {
    let entry = cache.get(network);
    if (entry?.pending) return entry.pending;
    if (entry?.result && entry.expires > now() && (!entry.result.snapshot || now() - entry.result.snapshot.observedAt <= 900)) return entry.result;
    entry = { expires: 0, last: entry?.last };
    cache.set(network, entry);
    const active = entry;
    active.pending = (async () => {
      let result: ExitQueueResponse;
      try {
        const snapshot = await collect(network);
        if (snapshot.network !== network || now() - snapshot.observedAt > 180) throw new Error("Invalid cached network or head");
        active.last = snapshot;
        active.expires = now() + 60;
        result = { network, status: "ready", snapshot };
      } catch {
        active.expires = now() + 30;
        const snapshot = active.last && now() - active.last.observedAt <= 900 ? active.last : null;
        result = { network, status: snapshot ? "stale" : "unavailable", snapshot,
          message: snapshot ? "Refresh failed. Showing an older Beacon snapshot." : "Current Beacon queue data is unavailable. Retrying automatically; no zero queue is assumed." };
      }
      active.result = result;
      active.pending = undefined;
      return result;
    })();
    return active.pending;
  };
}

export const readExitQueue = createExitQueueReader();
