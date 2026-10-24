import assert from 'node:assert/strict';
import test from 'node:test';
import { veboCacheExpiresAt } from '../app/vebo-cache.ts';

test('both snapshot modes expire ten minutes after collection',()=>{
 const timestamp=1_800_000_000,finished=(timestamp+3600)*1000;
 const job={finished,data:{meta:{timestamp},scenario:{frameHours:4.8}}};
 assert.equal(veboCacheExpiresAt(job,'frame'),finished+10*60_000);
 assert.equal(veboCacheExpiresAt(job,'finalized'),finished+10*60_000);
});
test('the next reporting frame invalidates a snapshot even within the ten-minute window',()=>{
 const timestamp=1_800_000_000,deadline=(timestamp+4.8*3600)*1000;
 const job={finished:deadline-60_000,data:{meta:{timestamp},scenario:{frameHours:4.8}}};
 assert.equal(veboCacheExpiresAt(job,'frame'),deadline);
 assert.equal(veboCacheExpiresAt(job,'finalized'),job.finished+600_000);
});
test('expired frame data is not made fresh by a late collection, and failures also wait ten minutes',()=>{
 const timestamp=1_800_000_000,finished=(timestamp+5*3600)*1000;
 const job={finished,data:{meta:{timestamp},scenario:{frameHours:4.8}}};
 assert.ok(veboCacheExpiresAt(job,'frame')<finished);
 assert.equal(veboCacheExpiresAt({...job,error:'Provider unavailable'},'frame'),finished+600_000);
});
