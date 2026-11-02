// CSS inline formatting for its common case: a block whose children are all
// text-only inline elements (<span>, <a>, <strong>, …). Such a block is laid out
// as one text leaf whose words carry each child's own font, and painted as runs
// per child, so mixed faces flow and wrap together as they do in a browser.
// Children are left out of the layout tree; the block measures and paints them.
import { renderedText } from './nerd-icon.js';

const INLINE_TAGS = new Set(['span', 'a', 'b', 'strong', 'i', 'em', 'code', 'small', 'mark', 'sub', 'sup',
  'abbr', 'cite', 'q', 's', 'u', 'kbd', 'var', 'time', 'data', 'dfn', 'samp', 'bdi', 'bdo']);
// A display utility makes the child something other than inline.
const DISPLAY_UTILITY = /(?:^|\s)(?:block|inline-block|flex|inline-flex|grid|inline-grid|hidden|table|contents|flow-root|list-item)(?:\s|$)/;

/** A text-only child that flows inline. */
export function isInlineLevel(element) {
  return element?.nodeType === 1 && INLINE_TAGS.has(element.localName) && !element.children.length && !element.hidden
    && !DISPLAY_UTILITY.test(element.className) && element.style.position !== 'absolute' && element.style.position !== 'fixed';
}

/** Whether `element` establishes an inline formatting context over its children. */
export function isInlineRoot(element) {
  if (element?.nodeType !== 1 || !element.children?.length || INLINE_TAGS.has(element.localName)) return false;
  const display = element.style.display;
  // Flex and grid containers blockify their children instead.
  if (display && display !== 'block' && display !== 'flow-root' && display !== 'inline-block') return false;
  // Pure Text children are leaf text on this element, not an inline formatting context.
  if (element.children.every((child) => child.nodeType === 3)) return false;
  if (renderedText(element)) return false;
  // Only element children participate; ignore inter-element Text.
  const kids = element.children.filter((child) => child.nodeType === 1);
  if (!kids.length) return false;
  return kids.every(isInlineLevel);
}
