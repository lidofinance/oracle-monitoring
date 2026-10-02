import assert from "node:assert/strict";
import test from "node:test";

import {
  filterWithCounts,
  parseSelection,
  toggleSelection,
} from "../app/filters.ts";

const MODULES = ["ao", "vebo", "csm"];

test("a selection is read from a comma-separated parameter", () => {
  assert.deepEqual(parseSelection("vebo,ao", MODULES), ["ao", "vebo"]);
  assert.deepEqual(parseSelection("AO", MODULES), ["ao"]);
  // Unknown values and the legacy "all" value mean no selection.
  assert.deepEqual(parseSelection("all", MODULES), []);
  assert.deepEqual(parseSelection("cm,unknown", MODULES), []);
  assert.deepEqual(parseSelection(null, MODULES), []);
});

test("toggling adds and removes a value in option order", () => {
  assert.deepEqual(toggleSelection([], "vebo", MODULES), ["vebo"]);
  assert.deepEqual(toggleSelection(["vebo"], "ao", MODULES), ["ao", "vebo"]);
  assert.deepEqual(toggleSelection(["ao", "vebo"], "ao", MODULES), ["vebo"]);
});

const REPORTS = [
  { module: "ao", phase: "hash", holder: "p2p" },
  { module: "ao", phase: "data", holder: "p2p" },
  { module: "ao", phase: "hash", holder: "lido" },
  { module: "vebo", phase: "hash", holder: "lido" },
  { module: "vebo", phase: "data", holder: undefined },
];

function filter(modules, phases, holders) {
  const { items, counts } = filterWithCounts(REPORTS, {
    module: { selected: modules, valueOf: (report) => report.module },
    phase: { selected: phases, valueOf: (report) => report.phase },
    holder: { selected: holders, valueOf: (report) => report.holder },
  });
  return {
    items,
    counts: Object.fromEntries(
      Object.entries(counts).map(([key, map]) => [key, Object.fromEntries(map)]),
    ),
  };
}

test("empty selections keep every item", () => {
  const { items, counts } = filter([], [], []);
  assert.equal(items.length, REPORTS.length);
  assert.deepEqual(counts, {
    module: { ao: 3, vebo: 2 },
    phase: { hash: 3, data: 2 },
    holder: { p2p: 2, lido: 2 },
  });
});

test("values of one group are alternatives, groups are combined", () => {
  const { items } = filter(["ao", "vebo"], ["hash"], []);
  assert.deepEqual(items, [REPORTS[0], REPORTS[2], REPORTS[3]]);
  assert.deepEqual(filter(["vebo"], ["hash"], ["p2p"]).items, []);
});

test("an item without a value fails a group that has a selection", () => {
  assert.deepEqual(filter([], [], ["lido"]).items, [REPORTS[2], REPORTS[3]]);
});

test("counts ignore the selection of their own group", () => {
  const { counts } = filter(["ao"], ["hash"], []);
  // Modules are counted over hash reports, phases over AO reports.
  assert.deepEqual(counts.module, { ao: 2, vebo: 1 });
  assert.deepEqual(counts.phase, { hash: 2, data: 1 });
  // Holders are counted over the reports that pass both other groups.
  assert.deepEqual(counts.holder, { p2p: 1, lido: 1 });
});
