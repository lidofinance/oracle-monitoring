import { DATA_REFRESH_INTERVAL_MS } from "./refresh-policy.ts";

export type VeboCacheInfo = { storedAt: number; expiresAt: number };

// Reuse completed snapshots for at most ten minutes, never beyond their frame.
// Its block timestamp can precede the reference slot when slots were missed;
// using that timestamp makes expiry conservative rather than late.
export function veboCacheExpiresAt(job: {
  finished: number;
  error?: string;
  data?: { meta: { timestamp?: number }; scenario: { frameHours?: number } };
}, reference: "frame" | "finalized"): number {
  const expiresAt = job.finished + DATA_REFRESH_INTERVAL_MS;
  if (job.error) return expiresAt;
  const timestamp = job.data?.meta.timestamp, hours = job.data?.scenario.frameHours;
  if (reference === "frame" && Number.isFinite(timestamp) && Number.isFinite(hours) && hours! > 0 && hours! <= 168) {
    return Math.min(expiresAt, (timestamp! + hours! * 3600) * 1000);
  }
  return expiresAt;
}
