import assert from 'node:assert/strict';
import test from 'node:test';
import { LIDO_ABI, WITHDRAWAL_ABI, VEBO_ABI, unbufferedAmount, ethAmount, parseFinalization, parseVeboExitRequest, finalizationHistoryComplete } from '../app/depositor-data.ts';

import { displayEth } from '../app/depositor-format.ts';
import { nominalVeboDays } from '../app/depositor-vebo.ts';
import { dailySnapshotTimes, blockAtOrBefore } from '../app/depositor-history.ts';

const lido = '0x0000000000000000000000000000000000000001';
function unbuffered(address, amount) {
  return { address, ...LIDO_ABI.encodeEventLog(LIDO_ABI.getEvent('Unbuffered'), [amount]) };
}
test('operation volume uses internally moved ETH, including multiple Unbuffered events', () => {
  const logs = [unbuffered(lido, 32000000000000000000n), unbuffered(lido, 1000000000000000000n)];
  assert.equal(unbufferedAmount(logs, lido), '33.0');
});
test('ignores similarly named events from other contracts and unrelated logs', () => {
  const logs = [unbuffered('0x0000000000000000000000000000000000000002', 2000000000000000000n), { address: lido, topics: [], data: '0x' }];
  assert.equal(unbufferedAmount(logs, lido), null);
  assert.equal(unbufferedAmount([unbuffered(lido, 0n)], lido), '0.0');
});
test('keeps wei precision until formatting and handles RPC hex quantities', () => {
  assert.equal(ethAmount('0xde0b6b3a7640001'), '1.000000000000000001');
  assert.equal(ethAmount('9662660472352671277094851'), '9662660.472352671277094851');
});


test('finalized request ranges include both endpoints and preserve the actual ETH locked', () => {
  const event = WITHDRAWAL_ABI.encodeEventLog(WITHDRAWAL_ABI.getEvent('WithdrawalsFinalized'), [100n, 102n, 950000000000000000n, 123n, 1792590000n]);
  const decoded = parseFinalization({ ...event, transactionHash: '0xabc', blockNumber: '0x64' });
  assert.equal(decoded.requests, 3);
  assert.equal(decoded.amount, '0.95');
  assert.equal(decoded.timestamp, 1792590000);
  assert.equal(decoded.firstRequestId, '100');
  assert.equal(decoded.lastRequestId, '102');
});
test('a single finalized request counts as one request', () => {
  const event = WITHDRAWAL_ABI.encodeEventLog(WITHDRAWAL_ABI.getEvent('WithdrawalsFinalized'), [10n, 10n, 2000000000000000000n, 1n, 1792590000n]);
  assert.equal(parseFinalization({ ...event, transactionHash: '0xdef', blockNumber: '0x65' }).requests, 1);
});
test('ETH moved drops insignificant zeros without rounding fractional ETH', () => {
  assert.equal(displayEth('3328.0000'), '3,328');
  assert.equal(displayEth('1.2300'), '1.23');
  assert.equal(displayEth('0.0'), '0');
  assert.equal(displayEth('0.000000000000000001'), '0.000000000000000001');
  assert.equal(displayEth('9662660.472352671277094851'), '9,662,660.472352671277094851');
});


test('VEBO requests use the publication timestamp and decode indexed validator identity', () => {
  const event = VEBO_ABI.encodeEventLog(VEBO_ABI.getEvent('ValidatorExitRequest'), [6n, 3n, 123456n, '0x' + 'ab'.repeat(48), 1792610000n]);
  const request = parseVeboExitRequest({ ...event, transactionHash: '0x123', blockNumber: '0x100' });
  assert.deepEqual(request, { hash: '0x123', block: 256, timestamp: 1792610000, moduleId: 6, nodeOperatorId: '3', validatorIndex: '123456' });
});
test('nominal VEBO demand groups publications by UTC day and counts repeated requests', () => {
  const midnight = Date.UTC(2026, 9, 21) / 1000;
  const days = nominalVeboDays([
    { timestamp: midnight - 1 }, { timestamp: midnight - 2 },
    { timestamp: midnight }, { timestamp: midnight + 3600 },
    { timestamp: midnight - 7 * 86400 },
  ], midnight + 7200);
  assert.equal(days.length, 7);
  assert.deepEqual(days[5], { timestamp: midnight - 86400, requests: 2, eth: 64 });
  assert.deepEqual(days[6], { timestamp: midnight, requests: 2, eth: 64 });
  assert.equal(days.reduce((sum, day) => sum + day.requests, 0), 4);
});
test('no VEBO events produce seven zero-valued nominal demand days', () => {
  const days = nominalVeboDays([], Date.UTC(2026, 9, 21, 12) / 1000);
  assert.ok(days.every(day => day.requests === 0 && day.eth === 0));
});

test('daily buffer snapshots use six UTC day closes and the current confirmed time', () => {
  const midnight = Date.UTC(2026, 9, 22) / 1000;
  const snapshots = dailySnapshotTimes(midnight + 3600);
  assert.equal(snapshots.length, 7);
  assert.equal(snapshots[0], midnight - 5 * 86400 - 1);
  assert.equal(snapshots[5], midnight - 1);
  assert.equal(snapshots[6], midnight + 3600);
  assert.equal(dailySnapshotTimes(midnight)[6], midnight);
});

test('daily block selection finds the last block before a cutoff despite missed slots', async () => {
  const timestamps = [0, 12, 24, 60, 72, 84, 120, 132];
  const blocks = timestamps.map((timestamp, number) => ({ number, timestamp }));
  for (const target of [0, 1, 23, 24, 25, 59, 60, 119, 120, 131, 132]) {
    const actual = await blockAtOrBefore(target, blocks[0], blocks.at(-1), async number => blocks[number]);
    assert.equal(actual, timestamps.findLastIndex(timestamp => timestamp <= target));
  }
  await assert.rejects(blockAtOrBefore(-1, blocks[0], blocks.at(-1), async number => blocks[number]));
});

test('finalization completeness requires contiguous request IDs and both boundary states',()=>{
 const events=[{firstRequestId:'21',lastRequestId:'30'},{firstRequestId:'11',lastRequestId:'20'}];
 assert.equal(finalizationHistoryComplete(events,'10','30'),true);
 assert.equal(finalizationHistoryComplete(events.slice(0,1),'10','30'),false);
 assert.equal(finalizationHistoryComplete(events,'9','30'),false);
 assert.equal(finalizationHistoryComplete(events,'10','31'),false);
 assert.equal(finalizationHistoryComplete([],'30','30'),true);
 assert.equal(finalizationHistoryComplete([],'30','31'),false);
});
test('duplicate, overlapping and malformed finalization ranges never appear complete',()=>{
 const e={firstRequestId:'11',lastRequestId:'20'};
 assert.equal(finalizationHistoryComplete([e,e],'10','20'),false);
 assert.equal(finalizationHistoryComplete([e,{firstRequestId:'20',lastRequestId:'30'}],'10','30'),false);
 assert.equal(finalizationHistoryComplete([{firstRequestId:'11',lastRequestId:'bad'}],'10','20'),false);
});
