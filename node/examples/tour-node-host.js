const TOUR_WINDOW_TITLE = "Nasty — JavaScript & DOM, full circle";

function parseTourArguments(args, environment) {
  const parameters = new URLSearchParams();
  for (const [variable, parameter] of [
    ["NASTY_TOUR_TIME_MULTIPLIER", "timeMultiplier"],
    ["NASTY_TOUR_DWELL_MS", "dwellMs"],
    ["NASTY_TOUR_CYCLES", "cycles"],
  ]) {
    if (environment[variable] !== undefined) parameters.set(parameter, environment[variable]);
  }
  let recordPath = environment.NASTY_TOUR_RECORD || null;
  const valueFlags = new Map([
    ["--record", "recordPath"],
    ["--time-multiplier", "timeMultiplier"],
    ["--timeMultiplier", "timeMultiplier"],
    ["--multiplier", "timeMultiplier"],
    ["--dwell-ms", "dwellMs"],
    ["--cycles", "cycles"],
  ]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: node node/examples/tour.js [--record output.mp4] [--time-multiplier value] [--dwell-ms value] [--cycles count]");
      process.exit(0);
    }
    const equalsAt = argument.indexOf("=");
    const flag = equalsAt < 0 ? argument : argument.slice(0, equalsAt);
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`unknown tour option: ${flag}`);
    let value = equalsAt < 0 ? undefined : argument.slice(equalsAt + 1);
    if (value === undefined) {
      value = args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    }
    if (!value) throw new Error(`empty value for ${flag}`);
    if (key === "recordPath") recordPath = value;
    else parameters.set(key, value);
  }
  if (recordPath) parameters.set("record", "1");
  return { parameters, recordPath };
}

function windowClientArea(execFileSync) {
  const tree = execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8" });
  const line = tree.split("\n").find((candidate) => candidate.includes(TOUR_WINDOW_TITLE));
  const id = line?.match(/^\s*(0x[\da-f]+)/i)?.[1];
  if (!id) throw new Error(`cannot find the Nasty tour window in the X11 tree (title: ${TOUR_WINDOW_TITLE})`);
  const info = execFileSync("xwininfo", ["-id", id], { encoding: "utf8" });
  const value = (label) => {
    const match = info.match(new RegExp(`^\\s*${label}:\\s*(-?\\d+)`, "m"));
    if (!match) throw new Error(`xwininfo did not report ${label}`);
    return Number(match[1]);
  };
  return { x: value("Absolute upper-left X"), y: value("Absolute upper-left Y"), width: value("Width"), height: value("Height") };
}

async function startRecording(path, refresh, { execFileSync, mkdir, dirname, resolve, spawn }) {
  const display = process.env.DISPLAY;
  if (!display) throw new Error("--record requires an X11 DISPLAY");
  const area = windowClientArea(execFileSync);
  if (area.width % 2 || area.height % 2) throw new Error(`MP4 yuv420p recording requires even dimensions, received ${area.width}x${area.height}`);
  await mkdir(dirname(path), { recursive: true });
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-f", "x11grab", "-draw_mouse", "0", "-framerate", (refresh > 0 ? refresh : 60).toFixed(3),
    "-video_size", `${area.width}x${area.height}`,
    "-i", `${display}+${area.x},${area.y}`,
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  const closed = new Promise((resolveClosed) => {
    child.once("error", (error) => resolveClosed({ error }));
    child.once("close", (code, signal) => resolveClosed({ code, signal }));
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  console.log(`recording ${area.width}x${area.height} at ${(refresh > 0 ? refresh : 60).toFixed(3)} Hz to ${resolve(path)}`);
  return { child, closed, path, stderr };
}

async function stopRecording(recorder, { execFileAsync }) {
  recorder.child.kill("SIGINT");
  let timeout;
  const result = await Promise.race([
    recorder.closed,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("ffmpeg did not finalize the recording within 15 seconds")), 15000); }),
  ]);
  clearTimeout(timeout);
  if (result.error) throw result.error;
  if (result.code !== 0 && result.code !== 255 && result.signal !== "SIGINT") throw new Error(`ffmpeg failed (${result.code ?? result.signal}): ${recorder.stderr}`);
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-show_entries", "format=duration", "-of", "json", recorder.path,
  ]);
  const metadata = JSON.parse(stdout);
  const stream = metadata.streams?.[0];
  const duration = Number(metadata.format?.duration);
  if (stream?.codec_name !== "h264" || !stream.width || !stream.height || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe found invalid MP4 output: ${stdout}`);
  }
  console.log(`recording finalized: ${recorder.path}; ${stream.width}x${stream.height} H.264, ${duration.toFixed(2)} s`);
}

export async function install() {
  const { execFile, execFileSync, spawn } = await import("node:child_process");
  const { mkdir } = await import("node:fs/promises");
  const { dirname, resolve } = await import("node:path");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { Document, TransitionEvent, Window } = await import("../index.js");

  const { parameters, recordPath: requestedRecordPath } = parseTourArguments(process.argv.slice(2), process.env);
  const recordPath = requestedRecordPath ? resolve(requestedRecordPath) : null;
  const requestedWidth = 1280;
  const requestedHeight = 720;
  const nativeWindow = new Window({
    resizable: "none",
    orientation: process.platform === "android" ? "landscape" : "auto",
    title: "Nasty — JavaScript & DOM, full circle",
    width: requestedWidth,
    height: requestedHeight,
    visible: false,
  });
  const nativeSize = nativeWindow.size();
  const width = process.platform === "android" && nativeSize.width > 0 ? nativeSize.width : requestedWidth;
  const height = process.platform === "android" && nativeSize.height > 0 ? nativeSize.height : requestedHeight;
  const document = new Document();
  nativeWindow.document = document;
  const view = new EventTarget();
  view.innerWidth = width;
  view.innerHeight = height;
  globalThis.document = document;
  globalThis.window = view;
  globalThis.location = { search: parameters.size ? `?${parameters}` : "" };
  globalThis.TransitionEvent = TransitionEvent;
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.freeze({ ready: Promise.resolve() }),
  });

  const callbacks = [];
  let callbackId = 0;
  globalThis.cancelAnimationFrame = (id) => {
    const index = callbacks.findIndex((entry) => entry.id === id);
    if (index >= 0) callbacks.splice(index, 1);
  };

  const refresh = nativeWindow.refreshRate();
  const frameBudget = 1000 / (refresh > 0 ? refresh : 60);
  let deadline = performance.now();
  let shown = false;
  let ended = false;
  let recorder = null;
  let frameScheduled = false;
  let frameRunning = false;
  let previousFrameAt = 0;
  const frameSamples = [];

  function scheduleFrame(delay = 0) {
    if (ended || frameScheduled || frameRunning) return;
    frameScheduled = true;
    setTimeout(() => frame().catch(async (error) => {
      console.error(`tour host failed: ${error.message}`);
      ended = true;
      if (recorder) {
        recorder.child.kill("SIGINT");
        await recorder.closed;
      }
      nativeWindow.close();
      process.exit(1);
    }), delay);
  }

  function dispatchNativeEvents() {
    for (const nativeEvent of nativeWindow.drainEvents()) {
      if (nativeEvent.type === "resize") {
        const size = nativeWindow.size();
        view.innerWidth = size.width;
        view.innerHeight = size.height;
      }
      const event = new Event(nativeEvent.type);
      if (nativeEvent.key !== undefined) {
        Object.defineProperty(event, "key", {
          value: nativeEvent.key === "Named(Escape)" ? "Escape" : nativeEvent.key,
        });
      }
      view.dispatchEvent(event);
    }
  }

  async function frame() {
    if (ended) return;
    frameScheduled = false;
    frameRunning = true;
    const now = performance.now();
    if (previousFrameAt) frameSamples.push(now - previousFrameAt);
    previousFrameAt = now;
    dispatchNativeEvents();
    for (const { callback } of callbacks.splice(0)) callback(now);
    nativeWindow.presentDocument();
    if (!shown) {
      nativeWindow.show();
      shown = true;
      if (recordPath) recorder = await startRecording(recordPath, refresh, { execFileSync, mkdir, dirname, resolve, spawn });
    }
    if (document.body.getAttribute("data-promo-status") === "complete") {
      ended = true;
      if (recorder) {
        console.log("holding final slide for 1.5 s before closing the MP4");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await stopRecording(recorder, { execFileAsync });
        recorder = null;
      }
      const percentile = (values, fraction) => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
      };
      const summarize = (values) => `${percentile(values, 0.5).toFixed(2)}/${percentile(values, 0.95).toFixed(2)}/${percentile(values, 1).toFixed(2)} ms`;
      console.log(`host frame interval median/p95/max ${summarize(frameSamples)}`);
      await document.close();
      nativeWindow.close();
      globalThis.document = null;
      globalThis.window = null;
      globalThis.location = null;
      globalThis.requestAnimationFrame = null;
      globalThis.cancelAnimationFrame = null;
      await new Promise((resolve) => process.stdout.write("", resolve));
      process.exit(0);
    }
    deadline += frameBudget;
    const afterPresent = performance.now();
    if (deadline < afterPresent - frameBudget) {
      deadline += (Math.floor((afterPresent - deadline) / frameBudget) + 1) * frameBudget;
    }
    frameRunning = false;
    scheduleFrame(Math.max(0, deadline - afterPresent));
  }

  globalThis.requestAnimationFrame = (callback) => {
    callbacks.push({ id: ++callbackId, callback });
    scheduleFrame();
    return callbackId;
  };
}
