// Layout of the shared window state block (Float64 slots) between the main
// thread and the window host thread.
export const STATE = {
  WIDTH: 0,
  HEIGHT: 1,
  CURSOR_X: 2,
  CURSOR_Y: 3,
  REFRESH_RATE: 4,
  CLOSED: 5,
  MAXIMIZED: 6,
  DECODE_PENDING: 7,
  DECODE_READY: 8,
  DECODE_IN_FLIGHT: 9,
  // Counts the window thread's pumps of the OS event loop.
  HEARTBEAT: 10,
  MAX_TEXTURE_DIMENSION: 11,
  // Wall-clock ms of the main thread's last event poll (it polls every few ms unless busy).
  MAIN_POLLED_AT: 12,
};

// Calls whose result nobody reads are posted without waiting; the window thread
// runs them in order, so a later synchronous call still sees their effects.
// Failures surface on the next synchronous call.
export const FIRE_AND_FORGET = new Set([
  "renderLayer", "updateTextPlacement", "setTextRunsNow", "setDragBlocked", "setBodyTransparency",
  "setSizeConstraints", "setScrollScene", "submitImageDecode", "present", "presentOrdered", "presentTransformed", "presentWithImages",
]);

// A presented frame is on the GPU before the next one starts: one in flight, so
// the main thread builds frame N+1 while the window thread presents frame N.
export const PRESENTS = new Set(["present", "presentOrdered", "presentTransformed", "presentWithImages"]);

// Int32 slots of the signal block.
export const SIGNAL = { REPLY: 0, EVENTS: 1, PRESENTS_SUBMITTED: 2, PRESENTS_DONE: 3 };
