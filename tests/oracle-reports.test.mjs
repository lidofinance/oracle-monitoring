import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";

import {
  collectReportLogs,
  decodeExtraDataList,
  frameReports,
  parseExtraDataReport,
  parseHashVote,
  parseOracleReport,
  safeHashVoteFrames,
  unwrapReportTransaction,
} from "../app/oracle-reports.ts";

const RECEIVER = "0x9b8bba11bbe1a351cc8dd1cfca6719ff7274a208";
const DELEGATION_CONTRACT = "0x929de74c921f3e719ad2bb026edef747d443dc8e";
const DELEGATE = "0xcad8aeeed49158e20f8429b28520541cfa2c27b1";

const FEE_ORACLE = new Interface([
  "function submitReportData((uint256 consensusVersion,uint256 refSlot,bytes32 treeRoot,string treeCid,string logCid,uint256 distributed,uint256 rebate,bytes32 strikesTreeRoot,string strikesTreeCid) data,uint256 contractVersion)",
]);
const DELEGATION = new Interface([
  "function execute(address target,bytes data) payable returns (bytes result)",
]);

const reportData = FEE_ORACLE.encodeFunctionData("submitReportData", [
  {
    consensusVersion: 4,
    refSlot: 3895615,
    treeRoot: `0x${"11".repeat(32)}`,
    treeCid: "bafytree",
    logCid: "bafylog",
    distributed: 10n ** 18n,
    rebate: 0n,
    strikesTreeRoot: `0x${"22".repeat(32)}`,
    strikesTreeCid: "bafystrikes",
  },
  3,
]);

const candidate = { hash: "0xabc", module: "csm_0x02", address: RECEIVER };

test("direct submitReportData calls are kept as is", () => {
  const transaction = {
    hash: "0xabc",
    from: DELEGATE,
    to: RECEIVER,
    input: reportData,
    blockNumber: "0x10",
  };
  const unwrapped = unwrapReportTransaction(transaction, candidate);
  assert.deepEqual(unwrapped, { transaction, module: "csm_0x02" });
});

test("EDF delegated calls are attributed to the delegation contract", () => {
  const transaction = {
    hash: "0xabc",
    from: DELEGATE,
    to: DELEGATION_CONTRACT,
    input: DELEGATION.encodeFunctionData("execute", [RECEIVER, reportData]),
    blockNumber: "0x10",
  };
  const unwrapped = unwrapReportTransaction(transaction, candidate);
  assert.ok(unwrapped);
  assert.equal(unwrapped.module, "csm_0x02");
  assert.equal(unwrapped.transaction.from, DELEGATION_CONTRACT);
  assert.equal(unwrapped.transaction.to, RECEIVER);
  assert.equal(unwrapped.transaction.input, reportData);

  const report = parseOracleReport("csm_0x02", unwrapped.transaction, 1_700_000_000);
  assert.ok(report);
  assert.equal(report.module, "csm_0x02");
  assert.equal(report.sender, DELEGATION_CONTRACT);
  assert.equal(report.refSlot, 3895615);
  assert.equal(report.contractVersion, "3");
  assert.ok(report.fields.some((field) => field.label === "Strikes tree root"));
});

test("delegated calls to another receiver are ignored", () => {
  const transaction = {
    hash: "0xabc",
    from: DELEGATE,
    to: DELEGATION_CONTRACT,
    input: DELEGATION.encodeFunctionData("execute", [
      "0x0000000000000000000000000000000000000001",
      reportData,
    ]),
    blockNumber: "0x10",
  };
  assert.equal(unwrapReportTransaction(transaction, candidate), null);
});

test("transactions without a recipient are ignored", () => {
  const transaction = {
    hash: "0xabc",
    from: DELEGATE,
    to: null,
    input: reportData,
    blockNumber: "0x10",
  };
  assert.equal(unwrapReportTransaction(transaction, candidate), null);
});

const ACCOUNTING_ORACLE = "0x852ded011285fe67063a08005c71a85690503cee";
const AO_CONSENSUS = "0xd624b08c83baecf0807dd2c6880c3154a5f0b288";
const MEMBER = "0x4e3f2deeb59eb9a205d82d17647b3e56422e0fee";
const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;

const EVENTS = new Interface([
  "event ReportReceived(uint256 indexed refSlot, address indexed member, bytes32 report)",
  "event ConsensusReached(uint256 indexed refSlot, bytes32 report, uint256 support)",
  "event ConsensusLost(uint256 indexed refSlot)",
  "event ProcessingStarted(uint256 indexed refSlot, bytes32 hash)",
  "event ExtraDataSubmitted(uint256 indexed refSlot, uint256 itemsProcessed, uint256 itemsCount)",
]);
const EXTRA_DATA = new Interface([
  "function submitReportExtraDataEmpty()",
  "function submitReportExtraDataList(bytes data)",
]);

let logCounter = 0;
function log(address, event, args) {
  logCounter += 1;
  return {
    address,
    ...EVENTS.encodeEventLog(event, args),
    blockNumber: `0x${logCounter.toString(16)}`,
    transactionHash: `0x${logCounter.toString(16).padStart(64, "0")}`,
  };
}

const hex = (value, bytes) => value.toString(16).padStart(bytes * 2, "0");

// One extra data item: index, type, module, operator ids and their values.
function extraDataItem(index, type, moduleId, operators) {
  return (
    hex(index, 3) +
    hex(type, 2) +
    hex(moduleId, 3) +
    hex(operators.length, 8) +
    operators.map(([id]) => hex(id, 8)).join("") +
    operators.map(([, value]) => hex(value, 16)).join("")
  );
}

test("report logs are split into phases", () => {
  const logs = [
    log(AO_CONSENSUS, "ReportReceived", [100, MEMBER, HASH_A]),
    log(AO_CONSENSUS, "ConsensusReached", [100, HASH_A, 5]),
    log(ACCOUNTING_ORACLE, "ProcessingStarted", [100, HASH_A]),
    log(ACCOUNTING_ORACLE, "ExtraDataSubmitted", [100, 2, 2]),
    // Events of contracts that are not tracked are ignored.
    log(RECEIVER, "ProcessingStarted", [100, HASH_A]),
    log(RECEIVER, "ReportReceived", [100, MEMBER, HASH_A]),
  ];
  const { candidates, hashVotes } = collectReportLogs(
    logs,
    { ao: ACCOUNTING_ORACLE },
    { ao: AO_CONSENSUS },
    10,
  );

  assert.deepEqual(candidates, [
    { hash: logs[2].transactionHash, module: "ao", address: ACCOUNTING_ORACLE },
    {
      hash: logs[3].transactionHash,
      module: "ao",
      address: ACCOUNTING_ORACLE,
      extraData: { refSlot: 100, itemsProcessed: 2, itemsCount: 2 },
    },
  ]);
  assert.deepEqual(hashVotes, [
    {
      module: "ao",
      address: AO_CONSENSUS,
      member: MEMBER,
      refSlot: 100,
      report: HASH_A,
      transactionHash: logs[0].transactionHash,
      blockNumber: logs[0].blockNumber,
      consensus: { report: HASH_A, support: 5 },
    },
  ]);
});

test("hash votes are limited to the latest frames", () => {
  const logs = [100, 200, 300].flatMap((refSlot) => [
    log(AO_CONSENSUS, "ReportReceived", [refSlot, MEMBER, HASH_A]),
    log(AO_CONSENSUS, "ReportReceived", [refSlot, DELEGATE, HASH_A]),
  ]);
  const { hashVotes } = collectReportLogs(logs, {}, { ao: AO_CONSENSUS }, 2);
  assert.deepEqual(
    hashVotes.map((vote) => vote.refSlot),
    [200, 200, 300, 300],
  );
});

test("a lost consensus is not attached to hash votes", () => {
  const logs = [
    log(AO_CONSENSUS, "ReportReceived", [100, MEMBER, HASH_A]),
    log(AO_CONSENSUS, "ConsensusReached", [100, HASH_A, 5]),
    log(AO_CONSENSUS, "ConsensusLost", [100]),
  ];
  const { hashVotes } = collectReportLogs(logs, {}, { ao: AO_CONSENSUS }, 10);
  assert.equal(hashVotes[0].consensus, undefined);
});

test("hash votes are compared with the consensus hash", () => {
  const vote = {
    module: "ao",
    address: AO_CONSENSUS,
    member: MEMBER,
    refSlot: 100,
    report: HASH_A,
    transactionHash: "0xabc",
    blockNumber: "0x10",
  };
  const value = (report, label) =>
    report.fields.find((field) => field.label === label)?.value;

  const matching = parseHashVote(
    { ...vote, consensus: { report: HASH_A, support: 5 } },
    1_700_000_000,
  );
  assert.equal(matching.phase, "hash");
  assert.equal(matching.sender, MEMBER);
  assert.equal(matching.receiver, AO_CONSENSUS);
  assert.equal(matching.blockNumber, 16);
  assert.equal(value(matching, "Vote"), "Matches consensus");
  assert.equal(matching.consensusMatch, true);

  const differing = parseHashVote(
    { ...vote, consensus: { report: HASH_B, support: 5 } },
    1_700_000_000,
  );
  assert.equal(value(differing, "Vote"), "Differs from consensus");
  assert.equal(differing.consensusMatch, false);

  const pending = parseHashVote(vote, 1_700_000_000);
  assert.equal(value(pending, "Vote"), "Consensus not reached");
  assert.equal(pending.consensusMatch, undefined);
  assert.equal(value(pending, "Consensus hash"), "Not reached");
});

test("extra data chunks are decoded into items", () => {
  const chunk =
    `0x${"cc".repeat(32)}` +
    extraDataItem(0, 2, 1, [[5, 120], [7, 3]]) +
    extraDataItem(1, 2, 3, [[11, 9]]);
  assert.deepEqual(decodeExtraDataList(chunk), {
    nextHash: `0x${"cc".repeat(32)}`,
    items: [
      {
        index: 0,
        type: 2,
        moduleId: 1,
        operators: [
          { operatorId: "5", value: "120" },
          { operatorId: "7", value: "3" },
        ],
      },
      {
        index: 1,
        type: 2,
        moduleId: 3,
        operators: [{ operatorId: "11", value: "9" }],
      },
    ],
  });
  // A chunk cut in the middle of an item is rejected.
  assert.equal(decodeExtraDataList(chunk.slice(0, -8)), null);
  assert.equal(decodeExtraDataList("0x1234"), null);
});

test("extra data transactions sent through EDF are decoded", () => {
  const chunk =
    `0x${"00".repeat(32)}` +
    extraDataItem(0, 2, 1, [[5, 120]]) +
    extraDataItem(1, 2, 1, [[7, 3]]);
  const candidate = {
    hash: "0xabc",
    module: "ao",
    address: ACCOUNTING_ORACLE,
    extraData: { refSlot: 100, itemsProcessed: 2, itemsCount: 2 },
  };
  const unwrapped = unwrapReportTransaction(
    {
      hash: "0xabc",
      from: DELEGATE,
      to: DELEGATION_CONTRACT,
      input: DELEGATION.encodeFunctionData("execute", [
        ACCOUNTING_ORACLE,
        EXTRA_DATA.encodeFunctionData("submitReportExtraDataList", [chunk]),
      ]),
      blockNumber: "0x10",
    },
    candidate,
  );
  assert.ok(unwrapped);

  const report = parseExtraDataReport(
    unwrapped.transaction,
    1_700_000_000,
    candidate.extraData,
  );
  assert.ok(report);
  assert.equal(report.phase, "extra");
  assert.equal(report.module, "ao");
  assert.equal(report.sender, DELEGATION_CONTRACT);
  assert.equal(report.refSlot, 100);
  const fields = Object.fromEntries(
    report.fields.map((field) => [field.label, field.value]),
  );
  assert.equal(fields["Items processed"], "2 of 2");
  assert.equal(fields["Next chunk hash"], "None, this is the last chunk");
  // Items of one module are merged into one field.
  assert.equal(
    fields["Exited validators · module 1"],
    "Operator 5: 120, Operator 7: 3",
  );
});

test("empty extra data submissions are decoded", () => {
  const transaction = {
    hash: "0xabc",
    from: DELEGATE,
    to: ACCOUNTING_ORACLE,
    input: EXTRA_DATA.encodeFunctionData("submitReportExtraDataEmpty"),
    blockNumber: "0x10",
  };
  const report = parseExtraDataReport(transaction, 1_700_000_000, {
    refSlot: 100,
    itemsProcessed: 0,
    itemsCount: 0,
  });
  assert.ok(report);
  assert.equal(
    report.fields.find((field) => field.label === "Extra data format")?.value,
    "0 (empty)",
  );
  // A report data call is not an extra data submission.
  assert.equal(
    parseExtraDataReport({ ...transaction, input: reportData }, 0, {
      refSlot: 100,
      itemsProcessed: 0,
      itemsCount: 0,
    }),
    null,
  );
});

test("the hash vote depth accepts only the listed values", () => {
  assert.equal(safeHashVoteFrames("20"), 20);
  assert.equal(safeHashVoteFrames("15"), 10);
  assert.equal(safeHashVoteFrames(null), 10);
});

test("frame reports share the module and the reference slot", () => {
  const report = (module, phase, refSlot, blockNumber) => ({
    module,
    phase,
    refSlot,
    blockNumber,
  });
  const reports = [
    report("ao", "extra", 100, 14),
    report("ao", "data", 100, 13),
    report("ao", "hash", 100, 12),
    report("ao", "hash", 100, 11),
    // Another module and another slot are other frames.
    report("vebo", "hash", 100, 10),
    report("ao", "hash", 200, 20),
  ];
  const frame = frameReports(reports, { module: "ao", refSlot: 100 });
  // Reports come in chain order inside a phase.
  assert.deepEqual(
    frame.hash.map((item) => item.blockNumber),
    [11, 12],
  );
  assert.deepEqual(frame.data, [reports[1]]);
  assert.deepEqual(frame.extra, [reports[0]]);
  assert.deepEqual(frameReports(reports, { module: "csm", refSlot: 100 }), {
    hash: [],
    data: [],
    extra: [],
  });
});
