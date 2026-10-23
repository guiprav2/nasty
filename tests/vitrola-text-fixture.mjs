import { fileURLToPath } from 'node:url';
process.env.NASTY_FONT_DIR = fileURLToPath(new URL('../node/examples/vitrola/', import.meta.url));
const { Document, Window } = await import('../node/index.js');
const { dominant } = await import('../node/dominant.js');
const doc = new Document();
const d = dominant(doc);
doc.body.className = 'flex gap-10 w-full h-full p-6 bg-black text-white font-[Inter] [transform:translateX(0px)]';
if (process.env.NASTY_TEXT_RASTER === '1') doc.body.classList.remove('[transform:translateX(0px)]');
const messages = ['Delete all playlists', 'Both playlists deleted.', 'Playlist created.', 'Delete it',
  'I meant by the 69 Eyes', 'Playlist created for The 69 Eyes track.'];
const bubbles = messages.map((message, index) => d.el('div', {
  id: `bubble-${index}`, class: 'max-w-[92%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere] bg-[#505050]',
}, d.text(() => message)));
const dynamic = d.el('div', { id: 'dynamic', class: 'w-[110px] px-3 py-2 text-sm bg-[#505050] whitespace-pre-wrap [overflow-wrap:anywhere]' },
  d.text(() => 'Playlist created.'));
doc.body.append(d.el('div', { class: 'flex shrink-0 w-[340px] flex-col gap-5' },
  ...bubbles.map(bubble => d.el('div', { class: 'flex w-full justify-start' }, bubble)), dynamic));
const textarea = d.el('textarea', { id: 'textarea', class: 'w-[320px] h-[90px] shrink-0 px-5 py-3 text-base bg-[#202430]',
  value: 'Line one\nLine two\nLine three\nLine four\nLine five' });
const input = d.el('input', { id: 'input', class: 'w-[320px] h-[28px] shrink-0 px-5 py-2 text-[32px] [line-height:40px] bg-[#202430]',
  value: 'MgMgMgMgMgMgMgMg' });
const composer = d.el('input', { id: 'composer', class: 'w-[320px] px-3 py-2 text-sm bg-[#202430]', value: '' });
doc.body.append(d.el('div', { class: 'flex flex-col gap-10' }, textarea, input, composer));
const logs = Array.from({ length: 24 }, (_, i) => d.el('div', {
  class: 'shrink-0 h-8 text-sm',
}, `Chat message ${i + 1}`));
const scroller = d.el('div', { class: 'absolute left-[430px] top-[360px] w-[300px] h-[128px] flex flex-col overflow-y-auto bg-[#202430]' }, ...logs);
doc.body.append(scroller);
const longLabel = 'Beginning of a deliberately long centered label';
const labels = ['text-center', 'text-left', 'text-center'].map((align, i) => d.el('div', {
  class: `absolute left-[430px] top-[${530 + i * 40}px] w-[180px] h-8 whitespace-nowrap overflow-hidden text-sm ${align}`,
}, i === 2 ? 'Short label' : longLabel));
doc.body.append(...labels);
const tallReference = d.el('input', { class: 'absolute left-6 top-[540px] w-[320px] h-[56px] px-5 py-2 text-[32px] [line-height:40px] bg-[#202430]',
  value: 'MgMgMgMgMgMgMgMg' });
doc.body.append(tallReference);
let scrollEvents = 0;
scroller.addEventListener('scroll', () => scrollEvents++);
const win = new Window({ title: 'Vitrola text regression', width: 960, height: 700, resizable: 'none', dragAnywhere: true });
win.document = doc;
const rect = element => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
process.on('message', message => {
  if (message.type === 'vertical-short') { input.value = 'MgMg'; tallReference.value = 'MgMg'; }
  if (message.type === 'scroll') scroller.scrollTop = message.top;
  if (message.type === 'append-log') scroller.append(d.el('div', { class: 'shrink-0 h-8 text-sm' }, 'New chat message'));
  if (message.type === 'widen') dynamic.classList.replace('w-[110px]', 'w-[300px]');
  if (message.type === 'report') process.send({ id: message.id, bubbles: bubbles.map(bubble => ({
    rect: rect(bubble), text: rect(bubble.children[0]), value: bubble.textContent,
  })), dynamic: rect(dynamic), textarea: rect(textarea), input: rect(input), composer: rect(composer),
    scroller: rect(scroller), scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight,
    firstLog: rect(logs[0]), scrollEvents, labels: labels.map(rect), tallReference: rect(tallReference) });
  if (message.type === 'close') { win.close(); doc.close(); process.exit(0); }
});
process.send({ ready: true });
