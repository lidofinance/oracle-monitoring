export const NOMINAL_EXIT_ETH = 32;

// This is nominal demand, not a measurement of live validator balances or
// completed exits. Every published request counts on its publication day.
export function nominalVeboDays(requests: readonly { timestamp: number }[], now: number) {
  const today = Math.floor(now / 86400) * 86400;
  const counts = new Map<number, number>();
  for (const request of requests) {
    const day = Math.floor(request.timestamp / 86400) * 86400;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return Array.from({ length: 7 }, (_, index) => {
    const timestamp = today - (6 - index) * 86400;
    const count = counts.get(timestamp) ?? 0;
    return { timestamp, requests: count, eth: count * NOMINAL_EXIT_ETH };
  });
}
