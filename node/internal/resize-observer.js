const observers = new Set();

function boxSize(element) {
  try {
    const rect = element.getBoundingClientRect();
    return { x: rect.x || 0, y: rect.y || 0, width: rect.width || 0, height: rect.height || 0 };
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function sameSize(a, b) {
  return a && b && a.width === b.width && a.height === b.height;
}

export class ResizeObserverEntry {
  constructor(target, box) {
    this.target = target;
    this.contentRect = {
      x: box.x, y: box.y, width: box.width, height: box.height,
      top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height,
    };
    this.borderBoxSize = [{ inlineSize: box.width, blockSize: box.height }];
    this.contentBoxSize = this.borderBoxSize;
    this.devicePixelContentBoxSize = this.borderBoxSize;
  }
}

export class ResizeObserver {
  constructor(callback) {
    if (typeof callback !== "function") throw new TypeError("ResizeObserver callback must be a function");
    this.callback = callback;
    this.targets = new Map();
    this.records = [];
    this.scheduled = false;
    observers.add(this);
  }

  observe(target) {
    if (!target || target.nodeType !== 1) throw new TypeError("ResizeObserver.observe requires an Element");
    if (this.targets.has(target)) return;
    const box = boxSize(target);
    this.targets.set(target, box);
    this.enqueue(target, box);
  }

  unobserve(target) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    this.records.length = 0;
  }

  enqueue(target, box) {
    this.records.push(new ResizeObserverEntry(target, box));
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.records.length) return;
      const records = this.records.splice(0);
      try { this.callback(records, this); } catch (error) { console.error(error); }
    });
  }
}

export function notifyResizeObservers() {
  for (const observer of observers) {
    for (const [target, previous] of observer.targets) {
      const next = boxSize(target);
      if (sameSize(previous, next)) continue;
      observer.targets.set(target, next);
      observer.enqueue(target, next);
    }
  }
}
