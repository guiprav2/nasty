import assert from 'node:assert/strict';
import * as nasty from '../index.js';
import * as tailwind from '../tailwind.js';
import { documentState, layoutDocument } from '../internal/dom-state.js';
import { parseColor } from '../render.js';
import { createRainbowUI } from '../examples/rainbow/ui.js';
import { textStyle } from '../internal/text-metrics.js';

const document = new nasty.Document();
try {
  const element = document.createElement('div');
  document.body.appendChild(element);
  element.className = 'marker w-[80px] h-[20px] border-2 shrink-1 [line-height:1.6]';
  const classes = element.classList;
  assert.equal(classes, element.classList, 'classList must be a stable live object');
  assert.equal(element.style.borderWidth, 2);
  assert.equal(element.style.borderTopWidth, 2, "border-N width shorthand expands to edge longhands");
  assert.equal(element.style.borderRightWidth, 2);
  element.classList.add('border-white/10');
  assert.equal(element.style.borderColor, 'rgba(255, 255, 255, 0.1)');
  assert.equal(element.style.borderTopColor, 'rgba(255, 255, 255, 0.1)', "border color shorthand expands to edge longhands");
  assert.equal(element.style.borderLeftColor, 'rgba(255, 255, 255, 0.1)');
  element.classList.remove('border-white/10');
  element.classList.add('p-4', 'm-2', 'gap-3', 'rounded-lg', 'overflow-hidden');
  assert.equal(element.style.padding, 16);
  assert.equal(element.style.paddingTop, 16, "padding shorthand expands to edge longhands");
  assert.equal(element.style.paddingRight, 16);
  assert.equal(element.style.margin, 8);
  assert.equal(element.style.marginBottom, 8, "margin shorthand expands to edge longhands");
  assert.equal(element.style.gap, 12);
  assert.equal(element.style.rowGap, 12, "gap shorthand expands to row/column longhands");
  assert.equal(element.style.columnGap, 12);
  assert.equal(element.style.borderRadius, 8);
  assert.equal(element.style.borderTopLeftRadius, 8, "rounded shorthand expands to corner longhands");
  assert.equal(element.style.overflow, 'hidden');
  assert.equal(element.style.overflowX, 'hidden', "overflow shorthand expands to axis longhands");
  assert.equal(element.style.overflowY, 'hidden');
  element.classList.remove('p-4', 'm-2', 'gap-3', 'rounded-lg', 'overflow-hidden');
  assert.equal(element.style.flexShrink, 1);
  assert.equal(element.style.lineHeight, '1.6');
  assert.equal(tailwind.resolveTailwind('[width:80]').width, undefined, 'CSS lengths require an explicit unit');
  assert.equal(tailwind.resolveTailwind('w-[80]').width, undefined, 'arbitrary width lengths require an explicit unit');
  assert.equal(tailwind.resolveTailwind('leading-[1.6]').lineHeight, '1.6');
  assert.equal(tailwind.resolveTailwind('leading-tight').lineHeight, '1.25');
  assert.equal(tailwind.resolveTailwind('leading-[24px]').lineHeight, '24px');
  assert.equal(textStyle(element).line, 25.6);
  assert.equal(element.style.setProperty, undefined);
  assert.equal(element.style.removeProperty, undefined);
  assert.equal(tailwind.setTailwindStyles, undefined);
  assert.equal(nasty.LayoutTree, undefined, 'native layout setters must stay internal');
  for (const mutate of [
    () => { element.style.width = 99; },
    () => { element.style = {}; },
    () => { element.style.cssText = 'width:99px'; },
    () => { delete element.style.width; },
    () => Object.defineProperty(element.style, 'width', { value: 99 }),
    () => element.setAttribute('style', 'width:99px'),
  ]) assert.throws(mutate, TypeError);

  await layoutDocument(document, 800, 600);
  const generation = documentState(document).paintGeneration;
  classes.add('w-[80px]');
  classes.remove('missing');
  assert.equal(classes.replace('w-[80px]', 'w-[80px]'), true);
  classes.add('another-marker');
  assert.equal(documentState(document).paintGeneration, generation);
  assert.equal(documentState(document).dirty, false);
  classes.replace('w-[80px]', 'w-[90px]');
  assert.equal(element.style.width, 90);
  assert.equal(documentState(document).dirty, true);
  await layoutDocument(document, 800, 600);
  classes.add('[transform:translateX(4px)]');
  classes.replace('[transform:translateX(4px)]', '[transform:translateX(8px)]');
  assert.equal(element.style.transform, 'translateX(8px)');
  assert.equal(documentState(document).dirty, false, 'transform changes must not invalidate layout');
  classes.toggle('hidden', true);
  assert.equal(element.style.display, 'none');
  classes.toggle('hidden', false);
  assert.equal(element.style.display, 'block', 'removing a utility must restore the original default');
  classes.remove('w-[90px]');
  assert.equal(element.style.width, undefined, 'removed declarations must not become defaults');
  assert.throws(() => classes.add('valid', 'invalid token'), { name: 'InvalidCharacterError' });
  assert.equal(classes.contains('valid'), false, 'invalid multi-token changes must be atomic');
  assert.throws(() => classes.replace('', 'valid'), { name: 'SyntaxError' });
  assert.equal(classes.replace('missing', 'valid'), false);
  classes.add('a', 'b');
  classes.replace('a', 'b');
  assert.equal([...classes].filter(value => value === 'b').length, 1);
  assert.equal(classes.contains('marker'), true);
  classes.add('[width-percent:1]', '[margin-left-auto:true]', '[direction:column]');
  assert.equal(element.style.widthPercent, undefined);
  assert.equal(element.style.marginLeftAuto, undefined);
  assert.equal(element.style.direction, undefined);
  assert.equal(Object.isFrozen(tailwind.resolveTailwind('p-4')), true);
  assert.deepEqual(parseColor('rgba(255, 100, 123, 5e-7)'), [1, 100 / 255, 123 / 255, 5e-7]);

  const ui = createRainbowUI(document);
  ui.resize(800, 600);
  ui.update(0);
  const elements = [...documentState(document).elements];
  const counts = elements.map(node => node.classList.length);
  for (let i = 0; i < 30; i++) { ui.resize(600 + i * 10, 600); ui.update(i * 20); }
  assert.deepEqual(elements.map(node => node.classList.length), counts, 'resize/animation must not accumulate tokens');
  ui.setMaximized(true);
  assert.equal(ui.maximizeButton.children[0].style.top, -0.33);
  ui.setTracingEnabled(true);
  assert.equal(document.body.style.backgroundColor, '#220b13');
  ui.setTracingEnabled(false);
  assert.equal(document.body.style.backgroundColor, '#080a12');
  console.log('Tailwind, read-only CSSOM, classList, and Rainbow update checks passed');
} finally {
  document.close();
}
