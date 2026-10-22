type TimedBlock = { number: number; timestamp: number };

// Past days use their closing state; today's point uses the confirmed head.
export function dailySnapshotTimes(now: number) {
  const today = Math.floor(now / 86400) * 86400;
  return Array.from({ length: 7 }, (_, i) => i === 6 ? now : today - (5 - i) * 86400 - 1);
}

export async function blockAtOrBefore(
  timestamp: number, first: TimedBlock, last: TimedBlock,
  read: (number: number) => Promise<TimedBlock>,
) {
  if (timestamp < first.timestamp) throw new Error("Snapshot predates available blocks");
  let lower = first, upper = last;
  if (timestamp >= upper.timestamp) return upper.number;
  while (upper.number - lower.number > 1) {
    const estimate = lower.number + Math.floor((timestamp - lower.timestamp) / (upper.timestamp - lower.timestamp) * (upper.number - lower.number));
    const candidate = await read(Math.max(lower.number + 1, Math.min(upper.number - 1, estimate)));
    if (candidate.timestamp <= timestamp) lower = candidate;
    else upper = candidate;
  }
  return lower.number;
}
