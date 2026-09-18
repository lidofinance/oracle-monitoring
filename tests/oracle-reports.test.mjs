import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";

import {
  parseOracleReport,
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
