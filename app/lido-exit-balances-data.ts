import { formatUnits } from "ethers";

export type LidoExitBalancePoint = {
  timestamp: number;
  beaconTimestamp: number | null;
  slot: number | null;
  balance: string | null;
  validators: number | null;
  status: "loading" | "ready" | "unavailable";
};
export type LidoExitBalanceHistory = {
  network: "mainnet" | "hoodi";
  status: "loading" | "ready";
  progress: string;
  points: LidoExitBalancePoint[];
  updatedAt: number;
};
export type ExitingValidator = {
  index: string;
  balance: string;
  status: string;
  validator: { pubkey: string; exit_epoch: string };
};
export const EXITING_STATUSES = ["active_exiting", "active_slashed", "exited_unslashed", "exited_slashed", "withdrawal_possible"];
const UINT64_MAX = BigInt("18446744073709551615");
export function beaconUint(value: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid Beacon integer");
  const n = BigInt(value);
  if (n > UINT64_MAX) throw new Error("Beacon integer overflow");
  return n;
}

/** Actual balances, not effective balances or a nominal 32 ETH multiplier.
 * Membership is established by KAPI; exits and consolidation sources belong
 * to the same historical Beacon state. Fully withdrawn zero balances add nothing.
 */
export function sumLidoExitBalances(
  records: ExitingValidator[], lidoKeys: ReadonlySet<string>,
  consolidations: { source_index: string; target_index: string }[], epoch: number,
) {
  if (!Array.isArray(records) || !Array.isArray(consolidations) || !Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Incomplete exit state");
  const sources = new Set(consolidations.map(c => { beaconUint(c.target_index); return beaconUint(c.source_index).toString(); }));
  const indexes = new Set<string>(), pubkeys = new Set<string>();
  let total = BigInt(0), validators = 0;
  for (const record of records) {
    const index = beaconUint(record.index).toString(), balance = beaconUint(record.balance), exit = beaconUint(record.validator.exit_epoch);
    const pubkey = record.validator.pubkey?.toLowerCase();
    if (!pubkey || !/^0x[\da-f]{96}$/.test(pubkey) || indexes.has(index) || pubkeys.has(pubkey) ||
        !EXITING_STATUSES.includes(record.status) || exit === UINT64_MAX ||
        (record.status.startsWith("active_") ? exit <= BigInt(epoch) : exit > BigInt(epoch))) throw new Error("Inconsistent exit registry");
    indexes.add(index); pubkeys.add(pubkey);
    if (balance === BigInt(0) || sources.has(index) || !lidoKeys.has(pubkey)) continue;
    total += balance; validators++;
  }
  return { balance: formatUnits(total, 9), validators };
}
