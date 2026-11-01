// Webfoundry promo → engineering review → Nasty integration, on one 1920×1080 stage.
// DOM + Tailwind classes only. Motion is transitions between class lists, named
// keyframes played through animate-* classes, and stepped class swaps, all placed
// on one beat timeline. Nasty owns presentation.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const examples = join(dirname(fileURLToPath(import.meta.url)), "..");
const covers = ["5NV6Rdv1a3I", "7maJOI3QMu0", "9E6b3swbnWg", "S-Xm7s9eGxU", "WNcsUNKlAKw", "eUDVUZZyA0M", "fWNaR-rxAic"]
  .map(id => join(examples, "vitrola", "covers", `${id}.jpg`));
const photos = [join(examples, "assets", "yellowstone-lake.jpg"), ...covers];

// Webfoundry landing palette.
const C = {
  cream: "#f6f4ef", ink: "#16171d", violet: "#7054ed", acid: "#d9ff7a", lavender: "#e8e2ff",
  lilac: "#a49bf2", midnight: "#11121b", muted: "#686570", sand: "#eae6dc", review: "#0c0f19",
};
// Treva theme.
const T = { ink950: "#100e0c", ink900: "#1b1814", ink800: "#2a241e", copper300: "#f3d2ae", copper500: "#e4a15a", gold300: "#f6d56e" };

const FADE = "transition-[opacity,transform] duration-700 ease-out";
const RISE_FROM = ["opacity-0", "translate-y-6"];
const RISE_TO = ["opacity-100", "translate-y-0"];

// `from` starts the timeline at that scene (0-based), for rehearsing one part.
export function mount(doc, parent, win, { from = 0 } = {}) {
  const el = (tag, className = "", ...children) => {
    const node = doc.createElement(tag);
    node.className = className;
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      if (typeof child === "string") {
        if (children.length === 1) node.textContent = child;
        else node.appendChild(el("span", "", child));
      } else node.appendChild(child);
    }
    return node;
  };
  const icon = (name, className = "") => el("span", `nf nf-md-${name} ${className}`);
  const img = (src, className) => {
    const node = el("img", className);
    node.setAttribute("src", src);
    return node;
  };
  // "Webfoundry" is always set in Pacifico (outside monospaced text), inline included.
  const wf = (text) => text.split(/(Webfoundry)/).filter(Boolean)
    .map(part => el("span", part === "Webfoundry" ? "font-[Pacifico] font-normal tracking-normal" : "", part));
  const swap = (node, pairs) => { for (const [from, to] of pairs) node.classList.replace(from, to); };

  // ── Timeline ───────────────────────────────────────────────────────────────
  const events = [];
  const scenes = [];
  let length = 0;
  let offset = 0;
  let current = null;
  let started = 0;
  let frame = 0;
  let stopped = false;
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const intervals = [];
  let lastTick = 0;

  const schedule = (at, run) => {
    let index = events.length;
    while (index > 0 && events[index - 1].at > at) index--;
    events.splice(index, 0, { at, run });
  };
  const scene = (ms, build, { fade = true } = {}) => {
    scenes.push({ start: length, ms, build, fade });
    length += ms;
  };

  function enter(entry) {
    const root = el("div", `absolute inset-0 flex overflow-hidden ${entry.fade ? "opacity-0 transition-opacity duration-500 ease-out" : ""}`);
    const at = (ms, run) => schedule(entry.start - offset + ms, run);
    entry.build(root, at);
    const previous = current;
    current = root;
    parent.appendChild(root);
    if (!previous) return entry.fade && at(40, () => root.classList.replace("opacity-0", "opacity-100"));
    if (!entry.fade) return previous.remove();
    root.addEventListener("transitionend", function done(event) {
      if (event.target !== root || event.propertyName !== "opacity") return;
      root.removeEventListener("transitionend", done);
      previous.remove();
    });
    at(40, () => root.classList.replace("opacity-0", "opacity-100"));
  }

  function tick(now) {
    if (stopped) return;
    if (lastTick) intervals.push(now - lastTick);
    if (intervals.length > 240) intervals.shift();
    lastTick = now;
    const elapsed = now - started;
    while (events.length && events[0].at <= elapsed) events.shift().run();
    frame = win.requestAnimationFrame(tick);
  }

  const frameStats = () => {
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    return { hz: median ? 1000 / median : 0, p95 };
  };

  // Rise-in helper: build on the from-classes, change at the beat.
  const riser = (tag, className, ...children) => el(tag, `${className} ${FADE} ${RISE_FROM.join(" ")}`, ...children);
  const rise = (node) => swap(node, [[RISE_FROM[0], RISE_TO[0]], [RISE_FROM[1], RISE_TO[1]]]);
  const show = (node) => node.classList.replace("opacity-0", "opacity-100");

  const kicker = (text, color = C.violet) =>
    el("div", `flex flex-row items-center gap-3 font-mono text-[18px] font-semibold uppercase tracking-[.16em] text-[${color}]`,
      el("div", `size-[8px] rounded-full bg-[${color}]`), el("span", "", text));
  // The Webfoundry mark: "wf" in Pacifico, as on the editor's home button.
  const brand = (dark = false) => el("div", "flex flex-row items-center gap-4",
    el("div", `flex size-[60px] items-center justify-center rounded-[16px] font-[Pacifico] text-[28px] leading-none ${dark ? `bg-white text-[${C.ink}]` : `bg-[${C.ink}] text-white`}`, "wf"),
    el("span", `font-[Pacifico] text-[32px] ${dark ? "text-white" : `text-[${C.ink}]`}`, "Webfoundry"));
  const headline = (lines, className) => el("div", `flex flex-col ${className}`,
    lines.map(([text, extra = ""]) => el("div", `leading-[1.02] ${extra}`, text)));
  const checkmark = (text, color = C.violet) => el("div", "flex flex-row items-center gap-2",
    icon("check_bold", `text-[20px] text-[${color}]`), el("span", "", text));

  // ── 1. Hero ────────────────────────────────────────────────────────────────
  scene(7800, (root, at) => {
    root.classList.add(`bg-[${C.cream}]`, `text-[${C.ink}]`, "flex-col", "items-center");
    root.append(
      el("div", "pointer-events-none absolute left-[1560px] top-[260px] h-[900px] w-[1100px] rounded-full bg-[radial-gradient(ellipse_at_center,_rgba(194,176,255,.45),_transparent_65%)] animate-glow animate-duration-[8s]"),
      el("div", "pointer-events-none absolute left-[260px] top-[760px] h-[700px] w-[900px] rounded-full bg-[radial-gradient(ellipse_at_center,_rgba(217,255,122,.32),_transparent_70%)] animate-glow animate-duration-[9s]"),
    );
    const top = riser("div", "absolute left-[96px] top-[64px] flex", brand());
    const pill = riser("div", "mt-[200px] flex flex-row items-center gap-3 rounded-full border border-[#16171d]/10 bg-white/75 px-5 py-3 text-[16px] font-semibold uppercase tracking-[.14em] text-[#5c596a]",
      el("div", `flex h-[28px] items-center justify-center rounded-[7px] bg-[${C.violet}] px-[6px] font-mono text-[14px] text-white tracking-normal`, "</>"),
      el("span", "", "The visual IDE for real software"));
    const line1 = riser("div", "mt-12 text-[176px] font-semibold leading-[.99] tracking-[-.085em]", "Make software");
    const bar = el("div", `absolute bottom-[14px] left-[4%] right-[-1%] h-[22px] rounded-full bg-[${C.acid}] origin-left rotate-[-1.8deg] scale-x-0 transition-transform duration-700 ease-out`);
    const line2 = riser("div", "flex flex-row items-end text-[176px] font-semibold leading-[.99] tracking-[-.085em]",
      el("div", "relative flex", bar, el("span", "relative", "your way")),
      el("span", `text-[${C.violet}]`, "."));
    const sub = riser("div", `mt-12 max-w-[1120px] text-center text-[32px] font-medium leading-[1.5] text-[${C.muted}]`,
      "Build visually. Write real JavaScript. Work alongside AI agents and teammates, all on the same editable app.");
    const checks = riser("div", `mt-10 flex flex-row gap-10 text-[22px] font-medium text-[#77737f]`,
      checkmark("No sign-up"), checkmark("Real projects"), checkmark("HTML + JavaScript"));
    root.append(top, pill, line1, line2, sub, checks);
    at(150, () => rise(top));
    at(350, () => rise(pill));
    at(550, () => rise(line1));
    at(680, () => rise(line2));
    at(1350, () => bar.classList.replace("scale-x-0", "scale-x-100"));
    at(1600, () => rise(sub));
    at(1900, () => rise(checks));
  });

  // ── 2. Three ways to build ─────────────────────────────────────────────────
  scene(10500, (root, at) => {
    root.classList.add(`bg-[${C.cream}]`, `text-[${C.ink}]`, "flex-col", "px-[96px]", "pt-[84px]");
    const head = el("div", "flex flex-row items-end justify-between");
    const title = riser("div", "flex flex-col gap-6", kicker("02 / One codebase, every way to build"),
      headline([["The right tool"], ["for every idea.", `text-[${C.violet}]`]], "text-[104px] font-semibold tracking-[-.075em]"));
    const lead = riser("div", `max-w-[620px] pb-3 text-[26px] leading-[1.55] text-[#6e6972]`,
      "Sometimes you want to drag a handle. Sometimes you want to write a function. Sometimes you want an agent to build the whole feature.");
    head.append(title, lead);

    const card = (bg, border, glyph, glyphClass, name, body, bodyClass, art) => riser("div",
      `flex h-[560px] flex-1 flex-col overflow-hidden rounded-[32px] border ${bg} ${border}`,
      el("div", "flex flex-col p-9 pb-0",
        el("div", `mb-8 flex size-[52px] items-center justify-center rounded-[14px] ${glyphClass}`, icon(glyph, "text-[28px]")),
        el("div", "text-[44px] font-semibold tracking-[-.06em]", name),
        el("div", `mt-3 max-w-[420px] text-[20px] leading-[1.55] ${bodyClass}`, body)),
      el("div", "mt-auto flex pl-10 pt-8", art));

    const handle = (pos) => el("div", `absolute ${pos} size-[14px] border-2 border-[${C.violet}] bg-white`);
    const tag = riser("div", `absolute -bottom-[34px] -right-[64px] rounded-[10px] bg-[${C.ink}] px-4 py-2 font-mono text-[15px] text-white`, "padding: 24px ↗");
    const canvasArt = el("div", "relative flex h-[230px] flex-1 flex-col rounded-tl-[22px] border border-[#bfb3ed] bg-white p-6",
      el("div", "flex flex-row items-center gap-3 border-b border-[#eae5f2] pb-4",
        el("div", `size-[10px] rounded-full bg-[${C.violet}]`),
        el("span", "text-[14px] font-semibold text-[#777084]", "DESIGN CANVAS"),
        el("span", `ml-auto font-mono text-[14px] text-[${C.violet}]`, "100%")),
      el("div", "mt-7 flex justify-center",
        el("div", `relative flex w-[300px] border-2 border-[${C.violet}] p-3`,
          el("div", "flex h-[84px] flex-1 items-center justify-center rounded-[8px] bg-gradient-to-br from-[#cca8ff] to-[#7e66e9] text-[20px] font-semibold text-white", "Hello, world"),
          handle("-left-[8px] -top-[8px]"), handle("-right-[8px] -top-[8px]"), handle("-bottom-[8px] -left-[8px]"), handle("-bottom-[8px] -right-[8px]"),
          tag)));

    const code = [
      [["export default class", "text-[#a699f7]"], [" App {", "text-[#eff5ff]"]],
      [["state", "text-[#ffbd88]"], [" = { items: [] };", "text-[#eff5ff]"]],
      [["actions", "text-[#ffbd88]"], [" = {", "text-[#eff5ff]"]],
      [["addItem", "text-[#ffbd88]"], [": () =>", "text-[#eff5ff]"]],
      [["this", "text-[#eff5ff]"], [".state.items.push(…),", "text-[#c1ed81]"]],
      [["};", "text-[#eff5ff]"]],
      [["}", "text-[#eff5ff]"]],
    ];
    const indents = [0, 1, 1, 2, 3, 1, 0];
    const codeLines = code.map((parts, index) => el("div", `flex flex-row pl-[${indents[index] * 22}px] opacity-0`, parts.map(([text, color]) => el("span", `whitespace-pre ${color}`, text))));
    const codeArt = el("div", "flex h-[230px] flex-1 flex-col overflow-hidden rounded-tl-[22px] border border-white/10 bg-[#0c0f18] font-mono text-[16px]",
      el("div", "flex h-[46px] flex-row items-center gap-3 border-b border-white/10 px-5 text-white/40",
        el("div", "size-[10px] rounded-full bg-[#a586f5]"), el("span", "", "controllers / App.js"), el("span", "ml-auto text-[#a5a1b0]", "JS")),
      el("div", "flex flex-col gap-[6px] px-6 pt-4", codeLines));

    const agentRows = [
      ["check_bold", "text-[#55ad56]", ["Selected ", ["#hero", "font-semibold text-[#16171d]"]]],
      ["check_bold", "text-[#55ad56]", ["Updated responsive classes"]],
      ["check_bold", "text-[#55ad56]", ["Validated page structure"]],
      ["creation", `text-[${C.violet}] animate-pulse`, ["Ready for your next instruction"]],
    ].map(([glyph, glyphClass, parts]) => el("div", "flex flex-row items-center gap-4 opacity-0",
      icon(glyph, `text-[20px] ${glyphClass}`),
      el("div", "flex flex-row text-[18px] text-[#646b5e]", parts.map(part => typeof part === "string" ? el("span", "whitespace-pre", part) : el("span", `whitespace-pre ${part[1]}`, part[0])))));
    const agentArt = el("div", "flex h-[230px] flex-1 flex-col rounded-tl-[22px] border border-[#bad9a4] bg-white p-5",
      el("div", "flex flex-row items-center gap-3 border-b border-[#e7efe0] pb-4",
        el("div", `flex size-[30px] items-center justify-center rounded-[8px] bg-[#1a2917] text-[${C.acid}]`, icon("creation", "text-[18px]")),
        el("span", "text-[18px] font-semibold", "Agent activity"),
        el("span", "ml-auto rounded-full bg-[#ebf8e0] px-3 py-1 text-[14px] font-semibold text-[#477a34]", "Editing")),
      el("div", "flex flex-col gap-4 pt-5", agentRows));

    const cards = [
      card(`bg-[${C.lavender}]`, "border-[#d9d2ef]", "cursor_default", `bg-white text-[${C.violet}]`, "See it. Shape it.",
        "Select, style, and arrange actual HTML on a live canvas. Every change stays editable.", "text-[#58536a]", canvasArt),
      card("bg-[#1c2030] text-white", "border-[#35364b]", "code_braces", `bg-white/10 text-[${C.acid}]`, "Code, for real.",
        "Plain JavaScript controllers, shared state, and declarative bindings. Bring your libraries.", "text-white/55", codeArt),
      card("bg-[#d9f4c1]", "border-[#c7e5ae]", "robot", "bg-white text-[#447c3a]", "Bring your agents.",
        "Coding agents edit with purpose-built tools, then you pick up where they left off.", "text-[#546b4b]", agentArt),
    ];
    root.append(head, el("div", "mt-14 flex flex-row gap-6", cards));
    at(200, () => rise(title));
    at(450, () => rise(lead));
    cards.forEach((node, index) => at(1300 + index * 140, () => rise(node)));
    at(2600, () => rise(tag));
    codeLines.forEach((line, index) => at(3000 + index * 150, () => line.classList.replace("opacity-0", "opacity-100")));
    agentRows.forEach((row, index) => at(4400 + index * 480, () => row.classList.replace("opacity-0", "opacity-100")));
  });

  // ── 3. Talk it through ─────────────────────────────────────────────────────
  scene(10500, (root, at) => {
    root.classList.add(`bg-[${C.sand}]`, `text-[${C.ink}]`, "flex-row", "items-center", "gap-[96px]", "px-[120px]");
    const left = riser("div", "flex w-[760px] flex-col",
      kicker("03 / Multimodal by nature"),
      headline([["Talk it through."], ["Take the wheel.", `text-[${C.violet}]`]], "mt-7 text-[100px] font-semibold tracking-[-.075em]"),
      el("div", `mt-9 text-[26px] leading-[1.55] text-[#635f69]`,
        wf("Say what you're trying to change. Webfoundry picks the right editing tool. Then drag, type, use shortcuts, or keep talking.")));
    const steps = [
      ["01", "Voice and text, one conversation", "Switch inputs without restarting a task."],
      ["02", "Precise, modal tools", "Adjust padding, alignment, and sizing with mouse and keyboard."],
      ["03", "Agents edit through the same tools", "Structural edits stay visual, validated, and undoable."],
    ].map(([n, title, body]) => riser("div", "mt-7 flex flex-row items-start gap-5",
      el("div", `flex size-[48px] shrink-0 items-center justify-center rounded-[14px] bg-white font-mono text-[16px] font-semibold text-[${C.violet}]`, n),
      el("div", "flex flex-col", el("div", "text-[22px] font-semibold", title), el("div", "mt-1 text-[19px] text-[#76717a]", body))));
    left.append(...steps);

    const pad = el("div", "flex flex-col rounded-[14px] bg-[#ddd4ff] p-[24px] transition-[padding] duration-[1800ms] ease-in-out",
      el("div", `flex items-center justify-center rounded-[8px] bg-[${C.violet}] py-6 text-[22px] font-semibold text-white`, "Your component"));
    const badge = el("div", `absolute -right-[46px] top-[44%] rounded-[10px] border border-[#a9c266] bg-[${C.acid}] px-4 py-2 font-mono text-[18px] font-semibold text-[#24341a]`, "24px ↔");
    const said = riser("div", "flex flex-row items-start gap-4",
      el("div", `flex size-[44px] shrink-0 items-center justify-center rounded-full bg-[${C.violet}] text-white`, icon("microphone", "text-[22px]")),
      el("div", "flex flex-col",
        el("div", "font-mono text-[13px] uppercase tracking-[.12em] text-white/45", "You said"),
        el("div", "mt-1 text-[22px] font-semibold text-white", "“I want to adjust this element's padding.”")));
    const reply = riser("div", "mt-5 flex flex-row items-start gap-4 border-t border-white/10 pt-5",
      el("div", `flex size-[44px] shrink-0 items-center justify-center rounded-full bg-[${C.acid}] text-[${C.ink}]`, icon("creation", "text-[22px]")),
      el("div", "flex flex-col",
        el("div", "font-mono text-[13px] uppercase tracking-[.12em] text-white/45", "Webfoundry"),
        el("div", "mt-1 text-[21px] text-white/85", "Padding tool active. Move your mouse to adjust. Say “left only” to constrain.")));
    const keys = ["↔ horizontal", "↕ vertical", "ESC cancel", "↵ commit"].map(text =>
      el("div", "rounded-full border border-white/15 px-4 py-2 font-mono text-[15px] text-white/55", text));
    const panel = riser("div", "flex w-[820px] flex-col rounded-[34px] border border-black/10 bg-[#171823] p-8",
      el("div", "flex flex-row items-center justify-between border-b border-white/10 pb-6",
        el("div", "flex flex-row items-center gap-3 font-mono text-[14px] tracking-[.14em] text-white/60",
          el("div", "size-[10px] rounded-full bg-[#83e89c] animate-pulse"), el("span", "", "LIVE EDIT SESSION")),
        el("span", "font-mono text-[14px] text-white/30", "Shift · constrain axis")),
      el("div", "flex h-[330px] items-center justify-center",
        el("div", "relative flex w-[440px] flex-col rounded-[14px] border-[3px] border-dashed border-[#b7a8fb] bg-white p-12",
          pad,
          el("div", `absolute -top-[16px] left-8 rounded-[7px] bg-[${C.violet}] px-3 py-1 text-[14px] font-semibold text-white`, "padding"),
          badge)),
      el("div", "flex flex-col rounded-[22px] bg-white/10 p-6", said, reply),
      el("div", "mt-5 flex flex-row gap-3", keys));
    root.append(left, panel);
    at(200, () => rise(left));
    steps.forEach((node, index) => at(900 + index * 140, () => rise(node)));
    at(500, () => rise(panel));
    at(1700, () => rise(said));
    at(2800, () => rise(reply));
    // The drag: padding glides through layout every frame; the readout counts along.
    const drag = (t, from, to) => {
      at(t, () => pad.classList.replace(`p-[${from}px]`, `p-[${to}px]`));
      const steps = Math.abs(to - from) / 4;
      for (let step = 1; step <= steps; step++) {
        // ease-in-out: the readout follows the eased value, not a straight line.
        const value = from + Math.sign(to - from) * step * 4;
        const progress = (value - from) / (to - from);
        const eased = progress < 0.5 ? Math.sqrt(progress / 2) : 1 - Math.sqrt((1 - progress) / 2);
        at(t + eased * 1800, () => { badge.textContent = `${value}px ↔`; });
      }
    };
    drag(3900, 24, 56);
    drag(6400, 56, 40);
  });

  // ── 4. Collaboration ───────────────────────────────────────────────────────
  scene(10500, (root, at) => {
    root.classList.add(`bg-[${C.midnight}]`, "text-white", "flex-col", "px-[120px]", "pt-[96px]");
    root.append(el("div", "pointer-events-none absolute left-[1700px] top-[80px] h-[1300px] w-[1300px] rounded-full bg-[radial-gradient(circle,_rgba(112,84,237,.26),_transparent_67%)] animate-glow animate-duration-[9s]"));
    const head = riser("div", "flex flex-row items-end justify-between",
      el("div", "flex flex-col", kicker("04 / Real-time collaboration", C.acid),
        headline([["Your whole team."], ["And their agents.", "text-[#b2a3ff]"]], "mt-6 text-[100px] font-semibold tracking-[-.075em]")),
      el("div", "max-w-[460px] pb-3 text-[24px] leading-[1.55] text-white/55",
        "A shared workspace where people and agents edit the same application in real time, without taking turns."));

    const cursor = (label, color, textColor, x, y) => el("div",
      `absolute left-0 top-0 flex flex-col items-start transition-transform duration-700 ease-out [transform:translate(${x}px,${y}px)]`,
      icon("cursor_default", `text-[30px] text-[${color}]`),
      el("div", `ml-5 rounded-[8px] bg-[${color}] px-3 py-1 text-[15px] font-semibold text-[${textColor}]`, label));
    const agent = cursor("Agent / responsive", C.acid, C.ink, 640, 300);
    const alice = cursor("↖ Alice / styling", C.violet, "#ffffff", 120, 120);
    const toast = riser("div", `absolute bottom-6 right-6 flex flex-row items-center gap-3 rounded-[14px] bg-white px-5 py-3 text-[18px] font-semibold text-[${C.ink}]`,
      icon("check_bold", "text-[20px] text-[#55ad56]"), el("span", "", "Agent B committed 3 changes"));
    const swatches = ["bg-[#7054ed]", "bg-[#d9ff7a]", "bg-[#a49bf2]"].map(bg => el("div", `h-[14px] w-[90px] rounded-full ${bg} transition-[width] duration-700 ease-out`));
    const dash = el("div", "relative flex h-[440px] flex-1 flex-col overflow-hidden rounded-[30px] border border-white/15 bg-[#20212f] p-10",
      el("div", "flex flex-row items-center gap-3 font-mono text-[14px] text-white/45",
        el("div", "size-[8px] rounded-full bg-[#83e89c]"), el("span", "", "pages / dashboard.html · auto-synced")),
      el("div", "mt-8 flex flex-1 flex-col justify-start rounded-[22px] bg-[#f6f4ef] p-10 text-[#16171d]",
        el("div", "font-mono text-[14px] tracking-[.14em] text-[#7b7984]", "YOUR DASHBOARD"),
        el("div", "mt-3 text-[46px] font-semibold leading-[1.05] tracking-[-.06em]", "Everything in its place."),
        el("div", "mt-6 flex flex-row gap-3", swatches)),
      agent, alice, toast);
    const features = [
      ["arrow_top_right", "P2P by design", "Peers join a room over WebRTC; edits flow between them."],
      ["account_multiple", "Independent presence", "Each human and agent has its own cursor and target."],
      ["undo", "Transactions & undo", "Structured HTML operations stay validated and reversible."],
    ].map(([glyph, title, body]) => riser("div", "flex flex-row items-start gap-5 rounded-[22px] border border-white/10 bg-white/5 p-6",
      el("div", `flex size-[46px] shrink-0 items-center justify-center rounded-[12px] bg-white/10 text-[${C.acid}]`, icon(glyph, "text-[24px]")),
      el("div", "flex flex-col", el("div", "text-[22px] font-semibold", title), el("div", "mt-1 text-[18px] leading-[1.45] text-white/55", body))));
    root.append(head, el("div", "mt-14 flex flex-row gap-6", dash, el("div", "flex w-[600px] flex-col gap-4", features)));
    at(200, () => rise(head));
    features.forEach((node, index) => at(900 + index * 140, () => rise(node)));
    const path = [
      [alice, [[120, 120], [360, 210], [300, 330], [520, 250]]],
      [agent, [[640, 300], [470, 140], [700, 120], [600, 360]]],
    ];
    for (const [node, points] of path) {
      points.forEach((point, index) => index && at(1600 + index * 1300 + (node === agent ? 400 : 0), () => {
        const [fromX, fromY] = points[index - 1];
        node.classList.replace(`[transform:translate(${fromX}px,${fromY}px)]`, `[transform:translate(${point[0]}px,${point[1]}px)]`);
      }));
    }
    at(5200, () => swatches[1].classList.replace("w-[90px]", "w-[180px]"));
    at(6300, () => rise(toast));
  });

  // ── 5. Hinge ───────────────────────────────────────────────────────────────
  scene(5200, (root, at) => {
    root.classList.add(`bg-[${C.ink}]`, "text-white", "flex-col", "items-center", "justify-center");
    const lines = ["Same files.", "Same DOM.", "Same project."].map(text => riser("div", "text-[132px] font-semibold leading-[1.05] tracking-[-.075em]", text));
    const sub = riser("div", "mt-10 text-[30px] text-white/55", "Your tools don't have to fight each other.");
    const next = riser("div", `mt-20 flex flex-row items-center gap-3 font-mono text-[18px] uppercase tracking-[.16em] text-[${C.acid}]`,
      el("span", "", "Next: how it works"), icon("arrow_right", "text-[22px]"));
    root.append(...lines, sub, next);
    lines.forEach((node, index) => at(200 + index * 260, () => rise(node)));
    at(1300, () => rise(sub));
    at(2300, () => rise(next));
  });

  // ── Engineering review: cut between sections, rows arrive in steps ─────────
  const reviewRoot = (root) => {
    root.classList.add(`bg-[${C.review}]`, "text-white", "flex-col", "px-[110px]", "pt-[72px]");
    return el("div", "flex flex-row items-center gap-4 border-b border-white/10 pb-6 font-mono text-[16px] text-white/45",
      el("div", `rounded-[8px] bg-[${C.violet}] px-3 py-1 font-semibold tracking-[.12em] text-white`, "ENGINEERING REVIEW"),
      el("span", "", "Webfoundry 5.7"),
      el("span", "ml-auto flex flex-row items-center gap-2", el("div", "size-[8px] rounded-full bg-[#45c68a]"), el("span", "", "node other/serve.js · localhost:8846")));
  };
  // Stepped reveals still fade, quickly, rather than popping in at full opacity.
  const QUICK = ["transition-opacity", "duration-300", "ease-out"];
  const fader = (node) => { node.classList.add(...QUICK); return node; };
  const stepIn = (at, nodes, from, gap = 120) => nodes.forEach((node, index) => { fader(node); at(from + index * gap, () => show(node)); });

  // ── 6. Review: status + metric row ─────────────────────────────────────────
  scene(7200, (root, at) => {
    const bar = reviewRoot(root);
    const title = el("div", "mt-16 flex flex-col",
      el("div", "text-[28px] text-white/50", "Section 1 of 4"),
      el("div", "mt-2 text-[120px] font-semibold leading-[1] tracking-[-.07em]", wf("How Webfoundry works")));
    const metric = (value, label, note) => el("div", "flex flex-1 flex-col border-l border-white/15 pl-8 opacity-0",
      el("div", `text-[120px] font-semibold leading-[1] tracking-[-.06em] text-[${C.acid}]`, value),
      el("div", "mt-4 text-[26px] font-semibold", label),
      el("div", "mt-2 font-mono text-[17px] text-white/45", note));
    const metrics = [
      metric("0", "build steps", "ES modules served as-is"),
      metric("8", "pages", "pages/*.html"),
      metric("16", "controllers", "controllers/*.js"),
      metric("37", "agent commands", "structured HTML editing"),
    ];
    const note = el("div", "mt-auto mb-[72px] flex flex-row items-center gap-3 text-[24px] text-white/60 opacity-0",
      icon("source_branch", `text-[26px] text-[${C.lilac}]`),
      el("div", "", wf("The editor is itself a Webfoundry app: same pages, controllers, and bindings it gives you.")));
    root.append(bar, title, el("div", "mt-20 flex flex-row gap-10", metrics), note);
    stepIn(at, metrics, 900, 220);
    stepIn(at, [note], 2400);
  }, { fade: false });

  // ── 7. Review: architecture ────────────────────────────────────────────────
  scene(9000, (root, at) => {
    const bar = reviewRoot(root);
    const layer = (n, glyph, path, name, body) => el("div", "flex flex-1 flex-col rounded-[26px] border border-white/10 bg-white/5 p-8 opacity-0",
      el("div", "flex flex-row items-center justify-between",
        el("div", `font-mono text-[18px] text-[${C.lilac}]`, n),
        icon(glyph, `text-[34px] text-[${C.acid}]`)),
      el("div", "mt-10 font-mono text-[20px] text-white/50", path),
      el("div", "mt-2 text-[38px] font-semibold tracking-[-.04em]", name),
      el("div", "mt-4 text-[21px] leading-[1.5] text-white/65", body));
    const layers = [
      layer("01", "language_html5", "pages/*.html", "Real HTML", "Bindings live in attributes: {{ }}, wf-if, wf-map, wf-on*, wf-value."),
      layer("02", "language_javascript", "controllers/*.js", "Controllers", "One class per file with state and actions. Pages call post('app.addItem')."),
      layer("03", "lightning_bolt", "webfoundry/dominant.js", "Reactive DOM", "Pages compile into live DOM. Mutate state and the bindings update."),
      layer("04", "tailwind", "class=\"…\"", "Tailwind styling", "Utility classes, edited live on the canvas. gfont-[…] loads Google Fonts."),
    ];
    const arrows = [0, 1, 2].map(() => el("div", "flex items-center text-white/30 opacity-0", icon("arrow_right", "text-[36px]")));
    const row = el("div", "mt-14 flex flex-row items-stretch gap-4");
    layers.forEach((node, index) => { row.appendChild(node); if (arrows[index]) row.appendChild(arrows[index]); });
    const foot = el("div", "mt-12 flex flex-row items-center gap-4 rounded-[20px] border border-[#7054ed]/50 bg-[#7054ed]/15 px-8 py-6 text-[24px] opacity-0",
      icon("robot", `text-[30px] text-[${C.acid}]`),
      el("span", "", "People, collaborators, and agents all edit through the same structured HTML operations."));
    root.append(bar, el("div", "mt-14 text-[72px] font-semibold tracking-[-.06em]", "One app model, four layers"), row, foot);
    [0, 1, 2, 3].forEach(index => {
      stepIn(at, [layers[index]], 700 + index * 900);
      if (arrows[index]) stepIn(at, [arrows[index]], 1150 + index * 900);
    });
    stepIn(at, [foot], 4600);
  }, { fade: false });

  // ── 8. Review: source → live app ───────────────────────────────────────────
  scene(10500, (root, at) => {
    const bar = reviewRoot(root);
    const tagColor = "text-[#a699f7]";
    const attr = "text-[#ffbd88]";
    const str = "text-[#c1ed81]";
    const plain = "text-[#eff5ff]";
    const bind = `text-[${C.acid}]`;
    const codePanel = (title, badge, lines) => {
      const rows = lines.map(([indent, parts], index) => el("div", "flex flex-row items-center opacity-0",
        el("span", "w-[44px] shrink-0 text-white/25", String(index + 1).padStart(2, "0")),
        el("div", `flex flex-row pl-[${indent * 22}px]`, parts.map(([text, color]) => el("span", `whitespace-pre ${color}`, text)))));
      const panel = el("div", "flex flex-1 flex-col overflow-hidden rounded-[24px] border border-white/10 bg-[#0d1220] font-mono text-[18px]",
        el("div", "flex h-[64px] flex-row items-center justify-between border-b border-white/10 px-7 text-[16px]",
          el("span", "text-white/55", title), el("span", `tracking-[.12em] text-[${C.acid}]`, badge)),
        el("div", "flex flex-col gap-[14px] px-7 py-7", rows));
      return { panel, rows };
    };
    const page = codePanel("pages / index.html", "SOURCE OF TRUTH", [
      [0, [["<section ", tagColor], ["class", attr], ["=", plain], ['"grid gap-6"', str], [">", tagColor]]],
      [1, [["<button ", tagColor], ["wf-onclick", attr], ["=", plain], ["\"post('app.addItem')\"", str], [">", tagColor]]],
      [2, [["Add", plain]]],
      [1, [["</button>", tagColor]]],
      [1, [["<div ", tagColor], ["wf-map", attr], ["=", plain], ['"item of state.app.items"', str], [">", tagColor]]],
      [2, [["<span>", tagColor], ["{{item.name}}", bind], ["</span>", tagColor]]],
      [1, [["</div>", tagColor]]],
      [0, [["</section>", tagColor]]],
    ]);
    const ctrl = codePanel("controllers / App.js", "PLAIN JS", [
      [0, [["export default class ", tagColor], ["App {", plain]]],
      [1, [["state", attr], [" = { items: [] };", plain]]],
      [1, [["actions", attr], [" = {", plain]]],
      [2, [["addItem", attr], [": () => {", plain]]],
      [3, [["this", plain], [".state.items.push(", plain]]],
      [4, [["{ name: ", plain], ["'foo'", str], [" });", plain]]],
      [2, [["},", plain]]],
      [1, [["};", plain]]],
    ]);
    const button = el("div", `flex h-[64px] w-[180px] items-center justify-center rounded-full bg-[${C.violet}] text-[22px] font-semibold text-white`, "Add");
    const items = [0, 1, 2, 3].map(index => el("div", "hidden flex-row items-center gap-4 rounded-[14px] bg-white px-5 py-4 text-[22px] text-[#16171d] opacity-0 transition-opacity duration-300 ease-out",
      el("div", "size-[10px] rounded-full bg-[#7054ed]"), el("span", "", "foo"), el("span", "ml-auto font-mono text-[16px] text-[#7b7984]", `items[${index}]`)));
    const count = el("div", "font-mono text-[18px] text-white/45", "state.app.items.length = 0");
    const live = el("div", "flex w-[460px] flex-col rounded-[24px] border border-white/10 bg-[#171a26] p-7 opacity-0",
      el("div", "flex flex-row items-center justify-between font-mono text-[16px] text-white/55",
        el("span", "", "LIVE CANVAS"), el("div", "size-[10px] rounded-full bg-[#45c68a] animate-pulse")),
      el("div", "mt-6 flex flex-col gap-3 rounded-[18px] bg-[#f6f4ef] p-6", button, el("div", "mt-2 flex flex-col gap-3", items)),
      el("div", "mt-5", count));
    root.append(bar,
      el("div", "mt-12 text-[64px] font-semibold tracking-[-.06em]", "Source in, live app out"),
      el("div", "mt-10 flex flex-row gap-6", page.panel, ctrl.panel, live));
    stepIn(at, page.rows, 500, 110);
    stepIn(at, ctrl.rows, 1500, 110);
    stepIn(at, [live], 2600);
    // Each click: button press is a step, the bound list grows by one row.
    [0, 1, 2, 3].forEach(index => {
      const t = 3600 + index * 1100;
      at(t, () => button.classList.replace(`bg-[${C.violet}]`, "bg-[#5f43df]"));
      at(t + 140, () => {
        button.classList.replace("bg-[#5f43df]", `bg-[${C.violet}]`);
        items[index].classList.replace("hidden", "flex");
        at(t + 180, () => show(items[index]));
        count.textContent = `state.app.items.length = ${index + 1}`;
      });
    });
  }, { fade: false });

  // ── 9. Review: what it enables ─────────────────────────────────────────────
  scene(9000, (root, at) => {
    const bar = reviewRoot(root);
    const cell = (glyph, title, value, body) => el("div", "flex flex-col rounded-[24px] border border-white/10 bg-white/5 p-8 opacity-0",
      el("div", "flex flex-row items-center justify-between",
        icon(glyph, `text-[34px] text-[${C.lilac}]`),
        el("div", `font-mono text-[18px] text-[${C.acid}]`, value)),
      el("div", "mt-8 text-[32px] font-semibold tracking-[-.03em]", title),
      el("div", "mt-3 text-[20px] leading-[1.5] text-white/60", body));
    const cells = [
      cell("vector_square", "Visual canvas", "live HTML", "Select, restyle, and rearrange real elements; nothing is generated behind your back."),
      cell("language_javascript", "Real JavaScript", "ES modules", "Controllers with state and actions. Import libraries straight from a CDN."),
      cell("robot", "Agents with tools", "37 commands", "The wf CLI and Companion server let coding agents edit pages structurally."),
      cell("account_multiple", "Live collaboration", "WebRTC rooms", "Peer-to-peer sessions; every peer gets its own cursor and selection."),
      cell("git", "Git & ZIP import", "in-browser", "Clone any HTTPS repo with isomorphic-git; import and export ZIPs."),
      cell("cloud_upload", "Deploy", "Netlify", "Publish to the web from the Settings menu."),
    ];
    root.append(bar,
      el("div", "mt-12 flex flex-row items-end justify-between",
        el("div", "text-[64px] font-semibold tracking-[-.06em]", "What it enables"),
        el("div", "text-[26px] text-white/45", "Section 2 of 4")),
      el("div", "mt-10 grid grid-cols-3 gap-6", cells));
    stepIn(at, cells, 500, 320);
  }, { fade: false });

  // ── 10. Review: how to use it ──────────────────────────────────────────────
  scene(10500, (root, at) => {
    const bar = reviewRoot(root);
    const steps = [
      ["Open the editor", "No account. Start from a template or an empty project."],
      ["Bring a project", "Import Git (HTTPS) or a ZIP from Settings."],
      ["Shape the pages", "Select elements on the canvas; style them with classes."],
      ["Write controllers", "State and actions in controllers/*.js, bound with {{ }} and wf-*."],
      ["Invite people and agents", "Share a collab room; point an agent at the project."],
      ["Ship it", "Deploy to Netlify, or export a ZIP."],
    ].map(([title, body], index) => el("div", "flex flex-row items-start gap-6 border-b border-white/10 py-5 opacity-0",
      el("div", `w-[56px] shrink-0 font-mono text-[22px] text-[${C.acid}]`, String(index + 1).padStart(2, "0")),
      el("div", "flex flex-col", el("div", "text-[28px] font-semibold", title), el("div", "mt-1 text-[20px] text-white/55", body))));
    // wf commands are the agent integration surface; people talk, agents run them.
    const ask = el("div", "flex flex-row items-start gap-4 border-b border-white/10 pb-6 opacity-0",
      el("div", `flex size-[40px] shrink-0 items-center justify-center rounded-full bg-[${C.violet}] text-white`, icon("microphone", "text-[20px]")),
      el("div", "flex flex-col",
        el("div", "font-sans text-[13px] uppercase tracking-[.12em] text-white/45", "You ask"),
        el("div", "mt-1 font-sans text-[22px] text-white", "“Center the hero and add an Add button.”")));
    const term = [
      ["→ ", "wf select-file pages/index.html"],
      ["→ ", "wf read-html"],
      ["→ ", "wf change-selection 12"],
      ["→ ", "wf add-css-classes flex justify-center items-center"],
      ["→ ", "wf create-last-child --html '<button>Add</button>'"],
      ["→ ", "wf add-event-handlers click=post('app.addItem')"],
      ["✓ ", "6 edits · validated · undoable"],
    ].map(([prompt, text], index, all) => el("div", "flex flex-row opacity-0",
      el("span", `whitespace-pre ${index === all.length - 1 ? "text-[#45c68a]" : `text-[${C.lilac}]`}`, prompt),
      el("span", index === all.length - 1 ? "text-[#45c68a]" : "text-white/85", text)));
    const terminal = el("div", "flex w-[820px] flex-col overflow-hidden rounded-[24px] border border-white/10 bg-black/40 font-mono text-[19px]",
      el("div", "flex h-[60px] flex-row items-center gap-3 border-b border-white/10 px-6 text-[16px] text-white/45",
        icon("robot", "text-[22px]"), el("span", "", "your agent · wf tools via Companion")),
      el("div", "flex flex-col gap-4 p-7", ask, term));
    root.append(bar,
      el("div", "mt-12 flex flex-row items-end justify-between",
        el("div", "text-[64px] font-semibold tracking-[-.06em]", "How to use it"),
        el("div", "text-[26px] text-white/45", "Section 3 of 4")),
      el("div", "mt-8 flex flex-row gap-16", el("div", "flex flex-1 flex-col", steps), el("div", "flex flex-col pt-4", terminal)));
    stepIn(at, steps, 500, 420);
    stepIn(at, [ask], 3000);
    stepIn(at, term, 3900, 560);
  }, { fade: false });

  // ── 11. Nasty: beyond the browser ──────────────────────────────────────────
  scene(8500, (root, at) => {
    root.classList.add(`bg-[${C.midnight}]`, "text-white", "flex-col", "px-[140px]", "pt-[150px]");
    root.append(el("div", "pointer-events-none absolute left-[1500px] top-[700px] h-[1100px] w-[1100px] rounded-full bg-[radial-gradient(circle,_rgba(217,255,122,.16),_transparent_65%)] animate-glow animate-duration-[9s]"));
    const title = riser("div", "flex flex-col", kicker("Section 4 of 4 · Beyond the browser", C.acid),
      headline([["Make it here."], ["Run it natively.", `text-[${C.acid}]`]], "mt-8 text-[150px] font-semibold tracking-[-.08em]"));
    const body = riser("div", "mt-10 max-w-[1150px] text-[32px] leading-[1.5] text-white/65",
      wf("Package Webfoundry apps with Nasty, a JavaScript-first native renderer. Familiar DOM APIs. Native windows. No browser window in sight."));
    const platforms = [
      ["microsoft_windows", "Windows"], ["linux", "GNU/Linux"], ["apple", "macOS"], ["apple_ios", "iPhone / iPad"], ["android", "Android"],
    ].map(([glyph, name]) => el("div", "flex flex-row items-center gap-3 rounded-full border border-white/15 bg-white/5 px-6 py-3 text-[24px] opacity-0",
      icon(glyph, `text-[26px] text-[${C.acid}]`), el("span", "", name)));
    const note = riser("div", "mt-auto mb-[80px] flex flex-row items-center gap-3 font-mono text-[18px] text-white/45",
      icon("creation", `text-[20px] text-[${C.acid}]`), el("span", "", "This tour is a Nasty app: DOM, Tailwind classes, and GPU compositing."));
    root.append(title, body, el("div", "mt-14 flex flex-row gap-4", platforms), note);
    at(200, () => rise(title));
    at(900, () => rise(body));
    stepIn(at, platforms, 1900, 150);
    at(3200, () => rise(note));
  });

  // ── 12. Nasty: export from Settings ────────────────────────────────────────
  scene(14000, (root, at) => {
    root.classList.add("bg-[#0a0c12]", "text-white", "flex-col", "px-[110px]", "pt-[80px]");
    const head = riser("div", "flex flex-row items-end justify-between",
      el("div", "flex flex-col", kicker("Coming to Webfoundry", C.acid),
        el("div", "mt-5 text-[76px] font-semibold tracking-[-.06em]", "One button next to Deploy")),
      el("div", "max-w-[520px] pb-2 text-[22px] leading-[1.5] text-white/55", "Settings gets an export dialog that builds native bundles for every target."));

    const menuItem = (text, extra = "") => el("div", `flex flex-row items-center rounded-[8px] px-4 py-3 text-[20px] text-white/85 ${extra}`, text);
    const exportItem = el("div", "flex flex-row items-center gap-3 rounded-[8px] bg-transparent px-4 py-3 text-[20px] text-white",
      el("span", "", "Export native app"),
      el("span", `ml-auto rounded-full bg-[${C.acid}] px-2 py-[2px] text-[13px] font-semibold text-[${C.ink}]`, "NEW"));
    const menu = el("div", "flex w-[380px] flex-col rounded-[14px] border border-white/10 bg-[#11151f] p-2",
      el("div", "flex flex-row items-center gap-3 px-4 pb-3 pt-2 font-mono text-[14px] tracking-[.12em] text-white/40", icon("cog", "text-[18px]"), el("span", "", "SETTINGS")),
      menuItem("Import Git (HTTPS)"), menuItem("Import ZIP"), menuItem("Export ZIP"), menuItem("Deploy to Netlify"), exportItem);
    const cursor = el("div", "absolute left-0 top-0 transition-transform duration-700 ease-out [transform:translate(560px,40px)]", icon("cursor_default", "text-[34px] text-white"));
    const editor = el("div", "relative flex h-[720px] w-[620px] flex-col rounded-[24px] border border-white/10 bg-[#0e1119] p-6",
      el("div", "flex flex-row items-center gap-2 pb-6",
        ...["#ff6b72", "#ffd166", "#52dca2"].map(color => el("div", `size-[12px] rounded-full bg-[${color}]`)),
        el("span", "ml-4 font-mono text-[15px] text-white/40", "webfoundry · counter")),
      menu, cursor);

    const targets = [
      ["microsoft_windows", "Windows", "counter-windows-x64.exe", "duration-1000"],
      ["linux", "GNU/Linux", "counter-linux-x64", "duration-1300"],
      ["apple", "macOS", "Counter.app", "duration-1600"],
      ["apple_ios", "iPhone / iPad", "Counter.ipa", "duration-2000"],
      ["android", "Android", "counter.apk", "duration-1500"],
    ].map(([glyph, name, file, duration]) => {
      const box = el("div", "flex size-[28px] items-center justify-center rounded-[7px] border-2 border-white/30 text-transparent", icon("check_bold", "text-[18px]"));
      const fill = el("div", `h-full w-full rounded-full bg-[${C.acid}] origin-left scale-x-0 transition-transform ${duration} ease-out`);
      const status = el("div", "w-[260px] text-right font-mono text-[16px] text-white/35", "queued");
      const row = el("div", "flex flex-row items-center gap-5 border-b border-white/10 py-4",
        box, icon(glyph, "text-[26px] text-white/80"), el("div", "w-[190px] text-[22px]", name),
        el("div", "h-[8px] flex-1 overflow-hidden rounded-full bg-white/10", fill), status);
      return { box, fill, status, file, row };
    });
    const build = el("div", `flex h-[60px] items-center justify-center rounded-full bg-[${C.violet}] px-8 text-[20px] font-semibold text-white`, "Build 5 bundles");
    const dialog = el("div", `flex w-[900px] flex-col rounded-[26px] border border-white/15 bg-[#151927] p-9 opacity-0 scale-95 ${FADE}`,
      el("div", "flex flex-row items-center justify-between",
        el("div", "flex flex-col",
          el("div", "text-[34px] font-semibold tracking-[-.04em]", "Export native app"),
          el("div", "mt-1 text-[19px] text-white/50", "Bundle this project with Nasty.")),
        el("div", "font-mono text-[16px] text-white/40", "com.example.counter")),
      el("div", "mt-7 flex flex-col", targets.map(target => target.row)),
      el("div", "mt-7 flex flex-row items-center justify-between",
        el("div", "text-[18px] text-white/45", "One JavaScript codebase · Nasty runtime included"), build));
    root.append(head, el("div", "mt-12 flex flex-row items-start gap-14", editor, dialog));
    at(200, () => rise(head));
    // Aim at the menu item where layout put it (the cursor is positioned in the editor's padding box).
    at(1300, () => {
      const frame = editor.getBoundingClientRect(), item = exportItem.getBoundingClientRect();
      const x = Math.round(item.x - frame.x - 1 + item.width * 0.7), y = Math.round(item.y - frame.y - 1 + item.height * 0.35);
      cursor.classList.replace("[transform:translate(560px,40px)]", `[transform:translate(${x}px,${y}px)]`);
    });
    at(2150, () => exportItem.classList.replace("bg-transparent", "bg-white/15"));
    at(2600, () => exportItem.classList.replace("bg-white/15", `bg-[${C.violet}]`));
    at(2800, () => swap(dialog, [["opacity-0", "opacity-100"], ["scale-95", "scale-100"]]));
    targets.forEach((target, index) => at(3700 + index * 200, () => {
      swap(target.box, [["border-white/30", `border-[${C.acid}]`], ["text-transparent", `text-[${C.ink}]`]]);
      target.box.classList.add(`bg-[${C.acid}]`);
    }));
    at(5000, () => build.classList.replace(`bg-[${C.violet}]`, "bg-[#5f43df]"));
    at(5140, () => {
      build.classList.replace("bg-[#5f43df]", `bg-[${C.violet}]`);
      build.textContent = "Building…";
      for (const target of targets) {
        target.status.textContent = "building";
        // Each row reports done when its own bar's transition ends.
        target.fill.addEventListener("transitionend", function done(event) {
          if (event.target !== target.fill || event.propertyName !== "transform") return;
          target.fill.removeEventListener("transitionend", done);
          target.status.textContent = target.file;
          target.status.classList.replace("text-white/35", `text-[${C.acid}]`);
          if (targets.every(t => t.status.textContent === t.file)) build.textContent = "5 bundles ready";
        });
        target.fill.classList.replace("scale-x-0", "scale-x-100");
      }
    });
  });

  // ── 13. Vitrola ────────────────────────────────────────────────────────────
  scene(13000, (root, at) => {
    root.classList.add("bg-[#070709]", "text-white", "font-[Inter]");
    // Title lockup, as in Vitrola's titleScreen(): glow, floating spinning disc, sheen.
    const lockup = el("div", "absolute inset-0 flex items-center justify-center opacity-100 transition-opacity duration-500 ease-out",
      el("div", "pointer-events-none absolute left-1/2 top-[34%] h-144 w-144 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(251,113,133,0.45)_0%,transparent_70%)] blur-3xl animate-glow"),
      el("div", "relative z-10 flex w-[384px] flex-col items-center [transform:scale(1.6)]",
        el("div", "animate-float",
          el("div", "relative h-44 w-44",
            img(join(examples, "vitrola", "logo.png"), "h-full w-full animate-spin animate-duration-[5s]"),
            el("div", "pointer-events-none absolute inset-[8%] overflow-hidden rounded-full",
              el("div", "absolute inset-y-[-10%] w-1/3 bg-gradient-to-r from-transparent via-white/55 to-transparent animate-sheen")))),
        el("div", "mt-7 text-3xl font-semibold", "Vitrola"),
        el("div", "mt-2 w-full text-center text-sm text-white/55", "A Grok API key opens the player. It stays on this machine until you forget it.")));

    // Cover flow with Vitrola's own pose() table and card classes.
    let center = 0;
    const pose = (offset) => {
      const abs = Math.abs(offset);
      const shifts = [0, 228, 292, 348, 396, 436];
      if (abs > 5.05) return "pointer-events-none opacity-0";
      const depths = [90, -20, -64, -104, -140, -172];
      const sizes = [1, 0.98, 0.94, 0.9, 0.86, 0.82];
      const opacities = [100, 100, 95, 82, 68, 52];
      const layers = [40, 28, 22, 16, 12, 8];
      const i = Math.min(Math.floor(abs), 5);
      const t = abs - i;
      const j = Math.min(i + 1, 5);
      const lerp = (values) => values[i] + (values[j] - values[i]) * t;
      const turn = abs < 0.001 ? 0 : (abs < 1 ? 50 * abs : 50) * (offset < 0 ? 1 : -1);
      const x = offset < 0 ? -lerp(shifts) : lerp(shifts);
      return `z-[${Math.round(lerp(layers))}] opacity-${Math.round(lerp(opacities))} [transform:translateX(${x}px)_translateZ(${lerp(depths)}px)_rotateY(${turn}deg)_scale(${lerp(sizes)})]`;
    };
    const cardClass = (index) => `group absolute inset-0 origin-center cursor-pointer transition-all ease-out duration-700 ${pose(index - center)}`;
    const frames = [];
    const cards = covers.map((src, index) => {
      const frame = el("div", "absolute inset-0 overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-white/10", img(src, "h-full w-full object-cover"));
      frames.push(frame);
      return el("div", cardClass(index), frame,
        el("div", "pointer-events-none absolute inset-x-0 top-[103%] h-[42%] overflow-hidden",
          img(src, "h-full w-full object-cover object-bottom [transform:scaleY(-1)]"),
          el("div", "absolute inset-0 bg-gradient-to-b from-[#070709]/45 via-[#070709]/82 to-[#070709]")));
    });
    const place = () => cards.forEach((card, index) => {
      card.className = cardClass(index);
      frames[index].className = `absolute inset-0 overflow-hidden rounded-xl bg-zinc-900 ${index === center ? "ring-2 ring-white/85" : "ring-1 ring-white/10"}`;
    });
    place();
    const flow = el("div", "absolute inset-0 flex flex-col items-center justify-center opacity-0 transition-opacity duration-700 ease-out",
      el("div", "flex w-[1100px] flex-col items-center [transform:scale(1.55)]",
        el("div", "relative perspective-[1600px] h-[22rem] w-full flex items-center justify-center",
          el("div", "relative aspect-video w-[22rem]", cards))));
    const caption = riser("div", "absolute bottom-[70px] left-[110px] flex flex-col",
      el("div", "font-mono text-[18px] uppercase tracking-[.16em] text-rose-300", "Built with Nasty · Vitrola"),
      el("div", "mt-3 text-[44px] font-semibold tracking-[-.04em]", "A media player with a 3D cover flow"),
      el("div", "mt-2 text-[22px] text-white/55", "Original classes and pose table; perspective, depth, and reflections composited on the GPU."));
    root.append(lockup, flow, caption);
    // The cover flow comes in only once the lockup has fully gone.
    at(3600, () => {
      lockup.addEventListener("transitionend", function gone(event) {
        if (event.target !== lockup || event.propertyName !== "opacity") return;
        lockup.removeEventListener("transitionend", gone);
        lockup.remove();
        flow.classList.replace("opacity-0", "opacity-100");
      });
      lockup.classList.replace("opacity-100", "opacity-0");
    });
    at(5000, () => rise(caption));
    [1, 2, 3, 4, 3, 2].forEach((value, index) => at(5600 + index * 1150, () => { center = value; place(); }));
  });

  // ── 14. Treva ──────────────────────────────────────────────────────────────
  scene(13000, (root, at) => {
    root.classList.add(`bg-[${T.ink950}]`, "text-[#f4efe8]", "font-sans");
    const kbd = (text) => el("span", "rounded-md border border-stone-400/10 bg-white/5 px-2 py-0.5 font-mono text-xs text-stone-300", text);
    const keys = [["Previous and next image", "← →"], ["Move a row in the grid", "↑ ↓"], ["Open the selected image", "Enter"],
      ["Back to the grid", "Esc"], ["Start or stop the slideshow", "Space"], ["Zoom in and out", "+ −"]]
      .map(([label, key]) => el("div", "flex flex-row items-center justify-between gap-6 border-b border-stone-400/4 py-1.5 text-sm",
        el("span", "text-stone-400", label), kbd(key)));
    // Treva's welcome() lockup, scaled for the stage.
    const welcome = el("div", "absolute inset-0 flex items-center justify-center opacity-100 transition-opacity duration-500 ease-out",
      el("div", "flex w-full max-w-xl flex-col [transform:scale(1.7)]",
        el("p", `text-xs uppercase tracking-[0.22em] text-[${T.copper500}]`, "Local viewer"),
        el("h1", "mt-2 font-display text-6xl text-stone-50", "Treva"),
        el("p", "mt-4 max-w-md text-lg leading-relaxed text-stone-300", "Open a folder and Treva lists every image in it, including nested ones. Files stay on this computer."),
        el("div", "mt-8 flex flex-row items-center gap-3",
          el("div", `rounded-full bg-[${T.copper500}] px-5 py-2.5 text-sm text-[${T.ink950}]`, "Open folder")),
        el("div", "mt-8 flex max-w-md flex-col", keys)));

    const columns = 8;
    const tiles = [];
    for (let index = 0; index < columns * 9; index++) {
      // Each row starts three photos on, so columns do not repeat.
      const image = img(photos[(index + Math.floor(index / columns) * 3) % photos.length], "relative z-10 h-full w-full object-cover bg-transparent opacity-0");
      const tile = el("div", `relative aspect-square w-full min-w-0 overflow-hidden rounded-md bg-[${T.ink800}] animate-pulse ring-1 ring-stone-400/6`, image);
      // As in Treva's thumbnail onload: the loaded image shows and the cell stops pulsing.
      image.addEventListener("load", () => {
        image.classList.replace("opacity-0", "opacity-100");
        tile.classList.remove("animate-pulse");
      });
      tiles.push(tile);
    }
    const grid = el("div", "grid w-full grid-cols-8 gap-3 p-6 transition-transform duration-[5200ms] ease-in-out translate-y-0", tiles);
    const header = el("div", `flex h-[64px] flex-row items-center gap-5 border-b border-stone-400/6 bg-[${T.ink900}] px-6`,
      el("div", "font-display text-xl text-stone-50", "Treva"),
      el("div", "text-sm text-stone-400", "Pictures"),
      el("div", `ml-auto rounded-full bg-[${T.copper500}]/15 px-3 py-1 text-xs text-[${T.copper300}]`, `${tiles.length} images`));
    const gallery = el("div", "absolute inset-0 flex flex-col opacity-0 transition-opacity duration-700 ease-out",
      header, el("div", "flex flex-1 overflow-hidden", grid));
    const caption = riser("div", `absolute bottom-[60px] left-[80px] flex flex-col rounded-[22px] border border-stone-400/10 bg-[${T.ink950}]/90 px-9 py-7`,
      el("div", `font-mono text-[18px] uppercase tracking-[.16em] text-[${T.copper500}]`, "Built with Nasty · Treva"),
      el("div", "mt-3 text-[44px] font-semibold tracking-[-.04em]", "A local image viewer"),
      el("div", "mt-2 text-[22px] text-stone-400", "CSS Grid on Taffy; Nasty admits and decodes thumbnails, drawn as GPU textures."));
    root.append(welcome, gallery, caption);
    at(3400, () => {
      welcome.addEventListener("transitionend", function gone(event) {
        if (event.target !== welcome || event.propertyName !== "opacity") return;
        welcome.removeEventListener("transitionend", gone);
        welcome.remove();
        gallery.classList.replace("opacity-0", "opacity-100");
      });
      welcome.classList.replace("opacity-100", "opacity-0");
    });
    at(4600, () => rise(caption));
    at(5600, () => grid.classList.replace("translate-y-0", "translate-y-[-560px]"));
    let selected = -1;
    [9, 10, 11, 19, 27, 28, 29, 37].forEach((index, step) => at(5200 + step * 700, () => {
      if (selected >= 0) tiles[selected].classList.replace(`ring-[${T.gold300}]`, "ring-stone-400/6");
      if (selected >= 0) tiles[selected].classList.replace("ring-2", "ring-1");
      tiles[index].classList.replace("ring-1", "ring-2");
      tiles[index].classList.replace("ring-stone-400/6", `ring-[${T.gold300}]`);
      selected = index;
    }));
  });

  // ── 15. Review: why Nasty (with this tour's own frame timing) ──────────────
  scene(10000, (root, at) => {
    const bar = reviewRoot(root);
    const cell = (glyph, title, body) => el("div", "flex flex-col rounded-[22px] border border-white/10 bg-white/5 p-7 opacity-0",
      icon(glyph, `text-[32px] text-[${C.lilac}]`),
      el("div", "mt-6 text-[28px] font-semibold tracking-[-.03em]", title),
      el("div", "mt-2 text-[19px] leading-[1.5] text-white/60", body));
    const cells = [
      cell("code_braces", "Standard DOM", "createElement, classList, events, transitionend. No invented APIs."),
      cell("palette", "Tailwind → CSSOM", "Classes resolve in JS; element.style reads the result."),
      cell("layers_triple", "Taffy layout", "Flex and grid from a native layout engine."),
      cell("chip", "WGPU compositing", "Layers, transforms, and blur combine on the GPU."),
      cell("speedometer", "Display-paced", "Frames follow the monitor's refresh rate and vsync."),
      cell("nodejs", "JavaScript first", "Policy lives in JS; native code is a thin bridge."),
    ];
    const value = (text) => el("div", `text-[110px] font-semibold leading-[1] tracking-[-.05em] text-[${C.acid}]`, text);
    const hz = value("—");
    const p95 = value("—");
    const refresh = win.refreshRate?.() || 0;
    const live = el("div", "flex w-[560px] flex-col rounded-[24px] border border-[#7054ed]/50 bg-[#7054ed]/12 p-9 opacity-0",
      el("div", "flex flex-row items-center gap-3 font-mono text-[16px] tracking-[.12em] text-white/55",
        el("div", "size-[10px] rounded-full bg-[#45c68a] animate-pulse"), el("span", "", "THIS TOUR, RIGHT NOW")),
      el("div", "mt-8 flex flex-row items-end gap-4", hz, el("span", "text-[30px] text-white/60", "Hz")),
      el("div", "mt-2 font-mono text-[17px] text-white/45", "median frame rate"),
      el("div", "mt-8 flex flex-row items-end gap-4", p95, el("span", "text-[30px] text-white/60", "ms")),
      el("div", "mt-2 font-mono text-[17px] text-white/45", "p95 frame interval"),
      el("div", "mt-8 font-mono text-[17px] text-white/45", refresh ? `display refresh ${refresh.toFixed(1)} Hz` : "display refresh unknown"));
    root.append(bar,
      el("div", "mt-12 flex flex-row items-end justify-between",
        el("div", "text-[64px] font-semibold tracking-[-.06em]", "Why Nasty"),
        el("div", "text-[26px] text-white/45", "Section 4 of 4")),
      el("div", "mt-10 flex flex-row gap-8", el("div", "grid flex-1 grid-cols-2 gap-5", cells), live));
    stepIn(at, cells, 400, 200);
    stepIn(at, [live], 1700);
    for (let t = 1700; t < 10000; t += 500) at(t, () => {
      const stats = frameStats();
      hz.textContent = stats.hz ? stats.hz.toFixed(1) : "—";
      p95.textContent = stats.p95 ? stats.p95.toFixed(1) : "—";
    });
  }, { fade: false });

  // ── 16. Finale ─────────────────────────────────────────────────────────────
  scene(8000, (root, at) => {
    root.classList.add(`bg-[${C.cream}]`, `text-[${C.ink}]`, "flex-col", "items-center", "justify-center");
    root.append(el("div", "pointer-events-none absolute left-[960px] top-[540px] h-[1000px] w-[1400px] rounded-full bg-[radial-gradient(ellipse_at_center,_rgba(194,176,255,.40),_transparent_65%)] animate-glow animate-duration-[8s]"));
    const logo = riser("div", "flex", brand());
    const line1 = riser("div", "mt-16 text-[136px] font-semibold leading-[1.02] tracking-[-.08em]", wf("Make it in Webfoundry."));
    const line2 = riser("div", `text-[136px] font-semibold leading-[1.02] tracking-[-.08em] text-[${C.violet}]`, "Ship it with Nasty.");
    const action = riser("div", `mt-16 flex flex-row items-center gap-3 rounded-full bg-[${C.violet}] px-10 py-6 text-[28px] font-semibold text-white`,
      el("span", "", "Open the editor"), icon("arrow_top_right", "text-[28px]"));
    const tagline = riser("div", "mt-8 font-mono text-[18px] tracking-[.14em] text-[#85818a]", "NO ACCOUNT NEEDED · LOCAL-FIRST · AGENT-READY · NATIVE-READY");
    root.append(logo, line1, line2, action, tagline);
    at(200, () => rise(logo));
    at(500, () => rise(line1));
    at(800, () => rise(line2));
    at(1700, () => rise(action));
    at(2100, () => {
      // The deck is done when its last transition reports in.
      tagline.addEventListener("transitionend", function done(event) {
        if (event.target !== tagline || event.propertyName !== "opacity") return;
        tagline.removeEventListener("transitionend", done);
        resolveFinished();
      });
      rise(tagline);
    });
  });

  if (!(from >= 0 && from < scenes.length)) throw new RangeError(`scene must be 1–${scenes.length}`);
  offset = scenes[from].start;
  for (const entry of scenes.slice(from)) schedule(entry.start - offset, () => enter(entry));

  return {
    durationMs: length - offset,
    finished,
    play() {
      started = performance.now();
      frame = win.requestAnimationFrame(tick);
    },
    destroy() {
      stopped = true;
      win.cancelAnimationFrame(frame);
      parent.replaceChildren();
    },
  };
}
