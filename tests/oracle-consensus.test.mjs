import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";
import { readConsensusFrame, voteStateFor } from "../app/oracle-consensus.ts";

test("an initial epoch in the future has no frame and does not abort other module reads", async () => {
  const inactive = { code: "CALL_EXCEPTION", data: id("InitialEpochIsYetToArrive()").slice(0, 10) };
  const active = [100n, 200n];
  const frames = await Promise.all([
    readConsensusFrame(async () => { throw inactive; }),
    readConsensusFrame(async () => active),
  ]);
  assert.deepEqual(frames, [null, active]);
});

test("unrelated reverts and RPC failures remain errors", async () => {
  for (const error of [
    { code: "CALL_EXCEPTION", data: "0xdeadbeef" },
    { code: "NETWORK_ERROR", data: "0xcd0883ea" },
    new Error("RPC unavailable"),
  ]) {
    await assert.rejects(readConsensusFrame(async () => { throw error; }), received => received === error);
  }
});

test("not-started committees are not counted as missed votes or missing membership", () => {
  assert.equal(voteStateFor(0, { notStarted: true }), "not-started");
  assert.equal(voteStateFor(undefined, { notStarted: true }), "unknown");
  const frame = { refSlot: 200, previousRefSlot: 100, deadlineSlot: 300 };
  assert.equal(voteStateFor(200, frame), "current");
  assert.equal(voteStateFor(100, frame), "previous");
  assert.equal(voteStateFor(99, frame), "missed");
  assert.equal(voteStateFor(200, undefined), "unknown");
});
