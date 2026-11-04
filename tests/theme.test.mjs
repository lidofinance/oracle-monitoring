import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {THEME_INIT_SCRIPT} from '../app/theme.ts';

function initialTheme(preference, systemDark, blocked=false) {
 const document={documentElement:{dataset:{}}};
 runInNewContext(THEME_INIT_SCRIPT,{document,localStorage:{getItem(){if(blocked)throw new Error('Storage blocked');return preference;}},matchMedia:()=>({matches:systemDark})});
 return document.documentElement.dataset.theme;
}
test('saved theme wins over system preference before the first paint',()=>{
 assert.equal(initialTheme('dark',false),'dark');
 assert.equal(initialTheme('light',true),'light');
});
test('a new visitor follows the system theme, including when storage is unavailable',()=>{
 for(const blocked of [false,true]){
  assert.equal(initialTheme(null,true,blocked),'dark');
  assert.equal(initialTheme(null,false,blocked),'light');
 }
 assert.equal(initialTheme('invalid',true),'dark');
});
