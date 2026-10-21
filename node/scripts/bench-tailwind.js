import { performance } from 'node:perf_hooks';
import { Document } from '../index.js';

// Bounded JS-only measurements. These do not measure GPU presentation or total FPS.
const document = new Document();
try {
  const elements = Array.from({ length: 500 }, () => {
    const element = document.createElement('div');
    element.className = 'w-[80px] h-[20px] bg-blue-500 [transform:translateX(0px)]';
    return element;
  });
  const previous = elements.map(() => '[transform:translateX(0px)]');
  for (const [label, count, unique] of [['500 unchanged tokens', 500, false], ['500 shared transforms', 500, false], ['42 distinct animated transforms', 42, true]]) {
    const samples = [];
    for (let pass = 0; pass < 50; pass++) {
      const begin = performance.now();
      for (let i = 0; i < count; i++) {
        const next = label.includes('unchanged') ? previous[i] : `[transform:translateX(${pass + 1 + (unique ? i / 100 : 0)}px)]`;
        elements[i].classList.replace(previous[i], next);
        previous[i] = next;
      }
      if (pass >= 10) samples.push(performance.now() - begin);
    }
    samples.sort((a, b) => a - b);
    console.log(`${label}: median ${samples[20].toFixed(3)} ms, p95 ${samples[38].toFixed(3)} ms`);
  }
} finally {
  document.close();
}
