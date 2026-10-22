import { isError } from "ethers";

export type FrameInfo = {
  refSlot: number;
  previousRefSlot: number;
  deadlineSlot: number;
} | { notStarted: true };

export type VoteState = "current" | "previous" | "missed" | "not-started" | "unknown";

// A deployed HashConsensus may intentionally have a future initial epoch.
// Only that specific contract response means no reporting frame exists yet.
export async function readConsensusFrame<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isError(error, "CALL_EXCEPTION") && error.data === "0xcd0883ea") return null;
    throw error;
  }
}

export function voteStateFor(slot: number | undefined, frame: FrameInfo | undefined): VoteState {
  if (slot === undefined || !frame) return "unknown";
  if ("notStarted" in frame) return "not-started";
  if (slot >= frame.refSlot) return "current";
  if (slot >= frame.previousRefSlot) return "previous";
  return "missed";
}
