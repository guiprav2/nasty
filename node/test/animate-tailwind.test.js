import assert from 'node:assert/strict';
import test from 'node:test';
import { Document } from '../index.js';
import { resolveTailwind } from '../tailwind.js';
import { computedStyleValue } from '../internal/css-transitions.js';
import { getRegisteredKeyframes } from '../internal/css-animations.js';

test('Tailwind default animate utilities resolve to named keyframes', () => {
  const pulse = resolveTailwind('animate-pulse');
  assert.equal(pulse.animationName, 'pulse');
  assert.equal(pulse.animationDuration, '2s');
  assert.equal(pulse.animationIterationCount, 'infinite');

  const bounce = resolveTailwind('animate-bounce');
  assert.equal(bounce.animationName, 'bounce');
  assert.equal(bounce.animationDuration, '1s');
  assert.equal(bounce.animationIterationCount, 'infinite');

  const ping = resolveTailwind('animate-ping');
  assert.equal(ping.animationName, 'ping');

  const spin = resolveTailwind('animate-spin');
  assert.equal(spin.animationName, 'spin');
  assert.equal(spin.animationTimingFunction, 'linear');
});

test('bounce keyframes keep percent units and per-keyframe easing', () => {
  const frames = getRegisteredKeyframes('bounce');
  assert.ok(frames?.length >= 3);
  assert.match(frames[0].class.join(' '), /translateY\(-25%\)/);
  assert.match(frames[1].class.join(' '), /translateY\(0%\)/);
  assert.equal(frames[0].easing, 'cubic-bezier(0.8, 0, 1, 1)');
  assert.equal(frames[1].easing, 'cubic-bezier(0, 0, 0.2, 1)');
});

test('animate-pulse samples opacity without a static opacity-* class', async () => {
  const doc = new Document();
  const el = doc.createElement('span');
  el.className = 'animate-pulse';
  el.textContent = '✨';
  doc.body.appendChild(el);
  assert.equal(el.style.opacity, undefined);
  assert.equal(el.style.animationName, 'pulse');
  const a = Number(computedStyleValue(el.style, 'opacity'));
  await new Promise((r) => setTimeout(r, 150));
  const b = Number(computedStyleValue(el.style, 'opacity'));
  assert.notEqual(a, b);
  assert.ok(a > 0.4 && a <= 1);
  assert.ok(b > 0.4 && b <= 1);
});
