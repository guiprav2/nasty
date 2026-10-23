import { renameSync, writeFileSync } from 'node:fs';
import { Document, Window } from '../node/index.js';
import { elementState } from '../node/internal/dom-state.js';

const reportPath = process.env.NASTY_INPUT_TEST_REPORT;
if (!reportPath) throw new Error('NASTY_INPUT_TEST_REPORT is required');
const win = new Window({ title: 'Nasty input visual regression', width: 820, height: 620, resizable: 'none' });
const doc = new Document();
doc.body.className = 'flex flex-col gap-3 w-[820px] h-[620px] p-6 bg-[#080a10] text-white font-[DejaVu_Sans]';

const heading = doc.createElement('div');
heading.className = 'h-6 shrink-0 text-base font-semibold';
heading.textContent = 'Input rendering checks';
const input = doc.createElement('input');
input.id = 'test-input';
input.className = 'w-[700px] h-11 shrink-0 rounded-md bg-[#202430] px-3 text-base text-white [transform:translateX(0px)]';
input.placeholder = 'MMMM '.repeat(50);
const textarea = doc.createElement('textarea');
textarea.id = 'test-textarea';
textarea.className = 'w-[700px] h-20 shrink-0 rounded-md bg-[#202430] px-3 py-2 text-base text-white';
textarea.value = 'First line\nSecond line';
const overflowTextarea = doc.createElement('textarea');
overflowTextarea.id = 'overflow-textarea';
overflowTextarea.className = 'w-[240px] h-20 shrink-0 rounded-md bg-[#202430] px-3 py-2 text-base text-white';
overflowTextarea.value = 'W'.repeat(80);
const chat = doc.createElement('div');
chat.id = 'chat-bubble';
chat.className = 'w-[300px] rounded-xl bg-[#30343d] px-3 py-2 text-sm text-white whitespace-pre-wrap [overflow-wrap:anywhere]';
chat.textContent = 'W'.repeat(220);
const shortChatRow = doc.createElement('div');
shortChatRow.className = 'flex w-full justify-start';
const shortChat = doc.createElement('div');
shortChat.id = 'short-chat-bubble';
shortChat.className = 'max-w-[92%] rounded-2xl bg-[#30343d] px-3 py-2 text-sm text-white whitespace-pre-wrap [overflow-wrap:anywhere]';
shortChat.textContent = 'Playlist created.';
shortChatRow.appendChild(shortChat);
const composer = doc.createElement('div');
composer.id = 'vitrola-composer';
composer.className = 'flex w-[320px] items-stretch overflow-hidden rounded-2xl border border-white/10 bg-black/40';
const composerInput = doc.createElement('input');
composerInput.id = 'vitrola-input';
composerInput.className = 'min-h-0 min-w-0 flex-1 rounded-l-2xl rounded-r-none bg-transparent px-3 py-2 text-sm text-white [transform:translateX(0px)]';
composerInput.placeholder = 'Play a more soothing playlist…';
const sendButton = doc.createElement('button');
sendButton.className = 'flex shrink-0 justify-center rounded-r-2xl bg-white px-4 py-2 text-sm font-semibold text-black';
sendButton.textContent = 'Send';
composer.append(composerInput, sendButton);
const sink = doc.createElement('div');
sink.id = 'report-sink';
sink.className = 'hidden';
doc.body.append(heading, input, textarea, overflowTextarea, chat, shortChatRow, composer, sink);
win.document = doc;

function rect(element) {
  const box = element.getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}
function report() {
  const temporaryPath = `${reportPath}.next`;
  writeFileSync(temporaryPath, JSON.stringify({
    input: { value: input.value, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, rect: rect(input),
      editor: { renderCaretX: elementState(input).renderCaretX, renderTextOriginX: elementState(input).renderTextOriginX,
        textOriginX: elementState(input).textAreaState?.textOriginX, caretX: elementState(input).textAreaState?.caretX,
        selectionRects: elementState(input).textAreaState?.selectionRects } },
    textarea: { value: textarea.value, selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd, rect: rect(textarea) },
    overflowTextarea: rect(overflowTextarea),
    chat: rect(chat),
    shortChat: rect(shortChat),
    bodyFontFamily: doc.body.style.fontFamily,
    composer: { rect: rect(composer), input: { value: composerInput.value, selectionStart: composerInput.selectionStart,
      selectionEnd: composerInput.selectionEnd, rect: rect(composerInput) }, send: rect(sendButton) },
  }));
  renameSync(temporaryPath, reportPath);
}
input.addEventListener('input', report);
textarea.addEventListener('input', report);
composerInput.addEventListener('input', report);
const reporter = setInterval(report, 40);
report();
process.on('SIGTERM', () => {
  clearInterval(reporter);
  win.close();
  doc.close();
  process.exit(0);
});
