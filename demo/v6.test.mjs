import {test} from 'node:test';
import assert from 'node:assert/strict';
import {carryPacket} from './src/v6/carry.ts';
import {recorded, claudeHintRows} from './src/v6/recorded.ts';

test('both packet cut edges remain opaque and use the ruled coordinates', () => {
  for (const [frame,x] of [[299,1892],[300,-28],[659,-28],[660,1892]]) {
    assert.equal(carryPacket(frame).x,x);
    assert.equal(carryPacket(frame).opacity,1);
    assert.equal(Math.min(1920,x+56)-Math.max(0,x),28);
  }
});
test('hanging hint rows preserve every captured word and remain within the column budget', () => {
  const normalized = text => text.replace(/\s+/g,' ').trim();
  assert.equal(normalized(claudeHintRows),normalized(recorded.claudeExpanded[1]));
  assert.equal(claudeHintRows.split('\n').length,4);
  for (const row of claudeHintRows.split('\n')) assert.ok(row.length<=93);
});
test('receiving packets reach their panels before any fade and stop at their fade deadline', () => {
  assert.deepEqual(carryPacket(318),{x:92,y:461,opacity:1});
  assert.deepEqual(carryPacket(678),{x:1772,y:621,opacity:1});
  assert.equal(carryPacket(502).opacity,0);
  assert.equal(carryPacket(814).opacity,0);
  assert.equal(carryPacket(815),null);
});
test('travel velocity matches on both sides of each remapped cut', () => {
  const epsilon = .0001;
  for (const [outgoing,incoming,speed] of [[299,300,20],[659,660,-20]]) {
    const before=(carryPacket(outgoing).x-carryPacket(outgoing-epsilon).x)/epsilon;
    const after=(carryPacket(incoming+epsilon).x-carryPacket(incoming).x)/epsilon;
    assert.ok(Math.abs(before-speed)<.001);
    assert.ok(Math.abs(after-speed)<.001);
  }
});
