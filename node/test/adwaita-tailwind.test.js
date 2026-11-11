import assert from 'node:assert/strict';
import test from 'node:test';
import { Document } from '../index.js';
import {
  resolveTailwind,
  setTailwindColorScheme,
  setTailwindHostKind,
  setTailwindOsKind,
} from '../tailwind.js';

test.afterEach(() => {
  setTailwindHostKind('desktop');
  setTailwindOsKind(null);
  setTailwindColorScheme('light');
});

test('adw-button resolves to standard longhands with px lengths', () => {
  let s = resolveTailwind('adw-button');
  assert.equal(s.display, 'flex');
  assert.equal(s.paddingTop, 9);
  assert.equal(s.paddingLeft, 12);
  assert.equal(s.borderTopLeftRadius, 8);
  assert.equal(s.backgroundColor, '#fafafa');
  assert.equal(s.fontWeight, 700);
  assert.equal(s.padding, undefined);
});

test('adw-* hover entries follow the hover interaction', () => {
  assert.notEqual(resolveTailwind('adw-button', 0, { hover: true }).backgroundColor, resolveTailwind('adw-button').backgroundColor);
});

test('breakpoint and platform variants prefix every adw-* entry', () => {
  assert.equal(resolveTailwind('md:adw-button', 500).display, undefined);
  assert.equal(resolveTailwind('md:adw-button', 800).display, 'flex');
  setTailwindHostKind('mobile');
  assert.equal(resolveTailwind('mobile:adw-button').display, 'flex');
  assert.equal(resolveTailwind('desktop:adw-button').display, undefined);
});

test('max-md: entries apply below the md breakpoint only', () => {
  assert.equal(resolveTailwind('adw-app-sidebar', 500).position, 'fixed');
  assert.notEqual(resolveTailwind('adw-app-sidebar', 1000).position, 'fixed');
});

test('win:/lin:/mac:/android: follow the OS and outrank desktop:/mobile:', () => {
  setTailwindOsKind('lin');
  assert.equal(resolveTailwind('lin:opacity-50').opacity, 0.5);
  assert.equal(resolveTailwind('win:opacity-50').opacity, undefined);
  assert.equal(resolveTailwind('mac:adw-button').display, undefined);
  assert.equal(resolveTailwind('lin:adw-button').display, 'flex');
  assert.equal(resolveTailwind('lin:opacity-25 desktop:opacity-50').opacity, 0.25);
  // The OS is independent of desktop:/mobile: (Linux phones are lin: + mobile:).
  setTailwindHostKind('mobile');
  assert.equal(resolveTailwind('lin:opacity-50').opacity, 0.5);
  assert.equal(resolveTailwind('lin:mobile:opacity-25').opacity, 0.25);
  assert.equal(resolveTailwind('lin:desktop:opacity-25').opacity, undefined);
  setTailwindOsKind('android');
  assert.equal(resolveTailwind('android:opacity-50').opacity, 0.5);
  assert.equal(resolveTailwind('lin:opacity-50').opacity, undefined);
});

test('dark: entries hold the Adwaita dark theme values', () => {
  let light = resolveTailwind('adw-button').backgroundColor;
  setTailwindColorScheme('dark');
  assert.notEqual(resolveTailwind('adw-button').backgroundColor, light);
  assert.equal(resolveTailwind('dark:opacity-50').opacity, 0.5);
});

test('compound modifiers apply on the element ([&.adw-suggested-action])', () => {
  let doc = new Document();
  let button = doc.createElement('button');
  button.className = 'adw-button';
  doc.body.appendChild(button);
  let plain = button.style.backgroundColor;
  button.className = 'adw-button adw-suggested-action';
  assert.equal(button.style.backgroundColor, '#3584e4');
  assert.notEqual(plain, '#3584e4');
});

test('attribute modifiers re-resolve on attribute changes ([&[disabled]])', () => {
  let doc = new Document();
  let button = doc.createElement('button');
  button.className = 'adw-button';
  doc.body.appendChild(button);
  assert.equal(button.style.opacity, undefined);
  button.setAttribute('disabled', '');
  assert.equal(button.style.opacity, 0.5);
  button.removeAttribute('disabled');
  assert.equal(button.style.opacity, undefined);
});

test('descendant rules retarget onto children ([&_.adw-icon])', () => {
  let doc = new Document();
  let button = doc.createElement('button');
  button.className = 'adw-button';
  let icon = doc.createElement('span');
  icon.className = 'adw-icon';
  button.appendChild(icon);
  doc.body.appendChild(button);
  assert.equal(icon.style.width, 16);
  assert.equal(icon.style.height, 16);
});

test('owner compound + descendant retargets only when the owner matches', () => {
  let doc = new Document();
  let wrap = doc.createElement('div');
  wrap.className = '[&.on_span]:opacity-40';
  let span = doc.createElement('span');
  wrap.appendChild(span);
  doc.body.appendChild(wrap);
  assert.equal(span.style.opacity, undefined);
  wrap.className = 'on [&.on_span]:opacity-40';
  assert.equal(span.style.opacity, 0.4);
});

test('adw-theme-dark on body switches the document to dark entries', () => {
  let doc = new Document();
  let button = doc.createElement('button');
  button.className = 'adw-button';
  doc.body.appendChild(button);
  let light = button.style.color;
  doc.body.className = 'adw-theme-dark';
  assert.equal(button.style.color, '#ffffff');
  doc.body.className = '';
  assert.equal(button.style.color, light);
});

test('element selectors map to adw-<tag> classes (adw-h1, adw-a, adw-all)', () => {
  assert.equal(resolveTailwind('adw-h1').fontWeight, 700);
  assert.equal(typeof resolveTailwind('adw-h1').marginTop, 'number');
  let link = resolveTailwind('adw-a').color;
  assert.notEqual(resolveTailwind('adw-a', 0, { hover: true }).color, link);
  assert.equal(resolveTailwind('adw-all').boxSizing, 'border-box');
});

test('custom-element rules apply to the adw-dialog class and its children', () => {
  let doc = new Document();
  let dialog = doc.createElement('div');
  dialog.className = 'adw-dialog';
  let header = doc.createElement('div');
  header.className = 'adw-dialog__header';
  dialog.appendChild(header);
  doc.body.appendChild(dialog);
  assert.equal(dialog.style.position, 'fixed');
  assert.equal(header.style.display, 'flex');
  dialog.setAttribute('open', '');
  assert.equal(dialog.style.display, 'flex');
  assert.equal(dialog.style.flexDirection, 'column');
});
