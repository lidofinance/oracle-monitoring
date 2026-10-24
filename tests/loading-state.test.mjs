import assert from 'node:assert/strict';
import test from 'node:test';
import {createLoadingRegistry} from '../app/loading-state.ts';
test('a finished main snapshot cannot hide an unfinished background dataset',()=>{
 const registry=createLoadingRegistry();
 registry.update('snapshot','mainnet','Balances','loading');registry.update('history','mainnet','Beacon history','loading');
 registry.update('snapshot','mainnet','Balances','ready');
 assert.equal(registry.snapshot('mainnet').pending,1);assert.deepEqual(registry.snapshot('mainnet').pendingLabels,['Beacon history']);
 registry.update('history','mainnet','Beacon history','ready');assert.equal(registry.snapshot('mainnet').pending,0);assert.equal(registry.snapshot('mainnet').errors,0);
});
test('terminal failure stops loading and a later retry becomes pending again',()=>{
 const registry=createLoadingRegistry();registry.update('forecast','mainnet','Forecast','loading');registry.update('forecast','mainnet','Forecast','error');
 assert.equal(registry.snapshot('mainnet').pending,0);assert.equal(registry.snapshot('mainnet').errors,1);
 registry.update('forecast','mainnet','Forecast','loading');assert.equal(registry.snapshot('mainnet').pending,1);assert.equal(registry.snapshot('mainnet').errors,0);
});
test('network switches and widget unmounts remove obsolete work without clearing other collectors',()=>{
 const registry=createLoadingRegistry();registry.update('page','mainnet','Page','loading');registry.update('widget','mainnet','Widget','loading');
 registry.remove('page');registry.update('page','hoodi','Page','ready');
 assert.equal(registry.snapshot('mainnet').pending,1);assert.equal(registry.snapshot('hoodi').pending,0);
 registry.remove('widget');assert.equal(registry.snapshot('mainnet').total,0);
});
test('unchanged snapshots remain stable and duplicate collectors cannot finish each other',()=>{
 const registry=createLoadingRegistry();let notifications=0;const unsubscribe=registry.subscribe(()=>notifications++);
 registry.update('a','mainnet','Forecast','loading');const snapshot=registry.snapshot('mainnet');registry.update('a','mainnet','Forecast','loading');assert.equal(registry.snapshot('mainnet'),snapshot);assert.equal(notifications,1);
 registry.update('b','mainnet','Forecast','loading');registry.update('a','mainnet','Forecast','ready');assert.equal(registry.snapshot('mainnet').pending,1);assert.deepEqual(registry.snapshot('mainnet').pendingLabels,['Forecast']);
 unsubscribe();registry.remove('b');assert.equal(notifications,3);
});
