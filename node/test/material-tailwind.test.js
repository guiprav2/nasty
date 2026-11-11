import assert from 'node:assert/strict';
import test from 'node:test';
import { Document } from '../index.js';
import { setTailwindColorScheme, setTailwindHostKind, setTailwindOsKind } from '../tailwind.js';
import { layoutDocument } from '../internal/dom-state.js';

// and-* (Beer CSS / Material 3) entries carry upstream specificity: `*` (and-all,
// folded into every tag class) < `button` (and-button) < `.chip` (and-chip), and
// own / compound / ancestor rules resolve as one cascade.

test.afterEach(() => {
  setTailwindHostKind('desktop');
  setTailwindOsKind(null);
  setTailwindColorScheme('light');
});

function el(doc, tag, className, parent = doc.body) {
  let e = doc.createElement(tag);
  e.className = className;
  parent.appendChild(e);
  return e;
}

test('a class beats the element rule it shares an element with (a.chip keeps its border)', () => {
  let doc = new Document();
  let chip = el(doc, 'a', 'and-a and-chip');
  assert.equal(chip.style.borderTopWidth, 1);
  assert.equal(chip.style.borderTopStyle, 'solid');
  assert.equal(chip.style.paddingLeft, 12);
  // Class order must not matter.
  let flipped = el(doc, 'a', 'and-chip and-a');
  assert.equal(flipped.style.borderTopWidth, 1);
});

test('the * reset is folded into tag classes and loses to everything', () => {
  let doc = new Document();
  let span = el(doc, 'span', 'and-span');
  assert.equal(span.style.position, 'relative');
  let button = el(doc, 'button', 'and-button');
  assert.equal(button.style.position, 'relative');
  assert.equal(button.style.paddingLeft, 16);
  let badge = el(doc, 'span', 'and-span and-badge', button);
  assert.equal(badge.style.position, 'absolute');
});

test('compound class rules beat the element base (button.circle)', () => {
  let doc = new Document();
  let button = el(doc, 'button', 'and-button and-circle');
  assert.equal(button.style.paddingLeft, 0);
  assert.equal(button.style.width, 40);
  assert.equal(button.style.height, 40);
});

test('nav alignment helpers beat the nav element rule', () => {
  let doc = new Document();
  assert.equal(el(doc, 'nav', 'and-nav and-right-align').style.justifyContent, 'flex-end');
  assert.equal(el(doc, 'nav', 'and-nav and-center-align').style.justifyContent, 'center');
});

test('field inputs fill the field (min height from .field > input)', () => {
  let doc = new Document();
  let field = el(doc, 'div', 'and-div and-field and-label and-border');
  let input = el(doc, 'input', 'and-input', field);
  let label = el(doc, 'label', 'and-label', field);
  assert.equal(field.style.position, 'relative');
  assert.equal(input.style.minHeight, 48);
  assert.equal(input.style.paddingLeft, 15);
  assert.equal(label.style.position, 'absolute');
  // Filled fields push the text below the floating label.
  let filled = el(doc, 'div', 'and-div and-field and-label and-fill');
  assert.equal(el(doc, 'input', 'and-input', filled).style.paddingTop, 16);
});

test('color: inherit undoes an earlier color (transparent buttons)', () => {
  let doc = new Document();
  let parent = el(doc, 'div', 'text-[#123456]');
  let transparent = el(doc, 'button', 'and-button and-circle and-transparent', parent);
  let filled = el(doc, 'button', 'and-button', parent);
  assert.equal(transparent.style.color, undefined); // inherits #123456
  assert.equal(filled.style.color, '#ffffff');
});

test('ancestor contexts apply: :has(> main) > header.fixed is sticky, not a full-window overlay', async () => {
  let doc = new Document();
  let column = el(doc, 'div', 'and-div');
  // Built incrementally like Webfoundry does: <main> arrives after the header resolved.
  let header = el(doc, 'header', 'and-header and-fixed', column);
  let lone = el(doc, 'header', 'and-header and-fixed');
  await layoutDocument(doc, 800, 600);
  assert.equal(header.style.position, 'fixed');
  let main = el(doc, 'main', 'and-main', column);
  await layoutDocument(doc, 800, 600);
  assert.equal(header.style.position, 'sticky');
  assert.equal(lone.style.position, 'fixed');
  main.remove();
  await layoutDocument(doc, 800, 600);
  assert.equal(header.style.position, 'fixed');
});

test('CSS text direction never reaches the layout flex direction', () => {
  let doc = new Document();
  // Beer sets direction: ltr on icons and sliders; the native layout only knows
  // flex directions and threw "unknown flex direction: ltr".
  for (let cls of ['and-i', 'and-label and-slider', '[direction:ltr]', '[direction:rtl]']) {
    let e = el(doc, 'div', cls);
    assert.ok(['ltr', 'rtl'].includes(e.style.direction), cls);
    assert.equal(e._taffyStyle().direction, undefined, cls);
  }
  let col = el(doc, 'div', '[direction:rtl] flex flex-col');
  assert.equal(col._taffyStyle().direction, 'column');
});

test('private custom properties propagate across rules (img.responsive)', () => {
  let doc = new Document();
  let hero = el(doc, 'img', 'and-img and-responsive and-round and-medium-height');
  assert.equal(hero.style.width, '100%');
  assert.equal(hero.style.height, 384);
  let avatar = el(doc, 'img', 'and-img and-circle');
  assert.equal(avatar.style.width, 48);
  assert.equal(avatar.style.height, 48);
  let small = el(doc, 'img', 'and-img and-circle and-small');
  assert.equal(small.style.width, 40);
  let banner = el(doc, 'img', 'and-img and-responsive and-small');
  assert.equal(banner.style.width, '100%');
  assert.equal(banner.style.height, 128);
});
