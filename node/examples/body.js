import { Document, Window } from "../index.js";

const window = new Window({ title: "Nasty body className", width: 900, height: 500, borderless: true, dragAnywhere: true });
const document = new Document();
window.document = document;

// Edit the one className field to change the body's Tailwind classes. The
// default demonstrates body-driven window constraints and appearance.
const initialClasses = "flex flex-col gap-5 p-8 bg-[#151923] text-white rounded-xl [min-width:620px] [max-width:1100px] [min-height:420px] [max-height:760px]";
document.body.className = initialClasses;

const heading = document.createElement("div");
heading.className = "text-2xl font-semibold";
heading.textContent = "Style the body with Tailwind classes";
const description = document.createElement("div");
description.className = "text-sm text-[#b9c4d5]";
description.textContent = "Change the className below. Body min/max dimensions constrain the window as soon as they change.";
const fieldLabel = document.createElement("div");
fieldLabel.className = "text-sm font-semibold";
fieldLabel.textContent = "document.body.className";
const field = document.createElement("input");
field.id = "body-class-name";
field.className = "w-full px-3 py-2 leading-[24px] bg-[#242b38] text-white rounded-md caret-emerald-400 selection:bg-blue-500/50 selection:text-white";
field.value = initialClasses;
const hint = document.createElement("div");
hint.className = "text-xs text-[#a9b5c8]";
hint.textContent = "Try [min-width:500px], [max-width:1000px], [min-height:400px], [max-height:800px], bg-[#203040], opacity-90, or rounded-2xl.";
document.body.append(heading, description, fieldLabel, field, hint);

let editorState = null;
let focused = false;

function stop() {
  window.close();
  document.close();
}

async function frame() {
  if (window.closed) return stop();
  for (const event of window.drainEvents()) {
    if (event.type === "close" || (event.type === "keydown" && event.key === "Named(Escape)")) {
      stop();
      return;
    }
    if (event.type === "pointerdown" && event.button === 0) {
      const rect = field.getBoundingClientRect();
      focused = event.x >= rect.x && event.x <= rect.x + rect.width && event.y >= rect.y && event.y <= rect.y + rect.height;
    }
  }

  const size = window.size();
  const fieldRect = field.getBoundingClientRect();
  if (fieldRect.width) {
    const paddingLeft = Number.parseFloat(field.style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(field.style.paddingRight) || 0;
    const paddingTop = Number.parseFloat(field.style.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(field.style.paddingBottom) || 0;
    const states = window.updateTextAreas([{
      id: "body-class-name",
      value: field.value,
      x: fieldRect.x + paddingLeft,
      y: fieldRect.y + paddingTop,
      width: fieldRect.width - paddingLeft - paddingRight,
      height: fieldRect.height - paddingTop - paddingBottom,
      fontSize: 16,
      lineHeight: 24,
      multiline: false,
      focus: focused,
    }]);
    editorState = states[0];
    if (editorState.value !== document.body.className) {
      document.body.className = editorState.value;
    }
  }
  if (!window.closed) setTimeout(frame, 16);
}

console.log("Edit the single field to set document.body.className. Click the field to focus; press Escape or close the window to exit.");
frame().catch(error => {
  console.error(error);
  stop();
});
