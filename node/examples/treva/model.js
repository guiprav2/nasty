// Pure list, layout, and zoom helpers shared by the viewer and its tests.

let IMAGE_EXT = new Set([
  'apng', 'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jfif', 'jpeg', 'jpg',
  'jxl', 'png', 'svg', 'tif', 'tiff', 'webp',
]);

let SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '$RECYCLE.BIN',
  'System Volume Information', '.Trash', '.Trashes', '.Spotlight-V100',
]);

let MIME = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  ico: 'image/x-icon',
  jfif: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  jxl: 'image/jxl',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

function extOf(name) {
  let base = String(name || '').split(/[/\\]/).pop();
  let dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

function isImageName(name) {
  return IMAGE_EXT.has(extOf(name));
}

function mimeFromExt(ext) {
  return MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name);
}

function formatBytes(n) {
  if (n == null || n !== n) return '—';
  let value = Number(n);
  if (value < 1024) return Math.round(value) + ' B';
  let units = ['KB', 'MB', 'GB', 'TB'];
  let index = -1;
  do {
    value /= 1024;
    index++;
  } while (value >= 1024 && index < units.length - 1);
  let digits = value >= 10 || Math.abs(value - Math.round(value)) < 0.05 ? 0 : 1;
  return value.toFixed(digits) + ' ' + units[index];
}

function formatDate(ms) {
  if (!ms) return '—';
  let dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(dt);
}

function formatDims(width, height) {
  if (!width || !height) return '—';
  let mp = (width * height) / 1e6;
  let extra = mp >= 0.1 ? ' · ' + mp.toFixed(mp >= 10 ? 0 : 1) + ' MP' : '';
  return width + ' × ' + height + extra;
}

function plural(n, word) {
  return String(n) + ' ' + word + (n === 1 ? '' : 's');
}

function cmpStr(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function compareImage(a, b, key) {
  if (key === 'path') return cmpStr(a.path, b.path);
  if (key === 'ext') return cmpStr(a.ext, b.ext) || cmpStr(a.name, b.name);
  if (key === 'size') return (a.size || 0) - (b.size || 0);
  if (key === 'modified') return (a.lastModified || 0) - (b.lastModified || 0);
  return cmpStr(a.name, b.name);
}

function visibleImages(images, opts) {
  let filter = String((opts && opts.filter) || '').trim().toLowerCase();
  let recursive = !opts || opts.recursive !== false;
  let list = [];
  for (let im of images) {
    if (!recursive && String(im.path || '').includes('/')) continue;
    if (filter) {
      let name = String(im.name || '').toLowerCase();
      let path = String(im.path || '').toLowerCase();
      if (!name.includes(filter) && !path.includes(filter)) continue;
    }
    list.push(im);
  }
  let dir = opts && opts.sortDir === 'desc' ? -1 : 1;
  let key = (opts && opts.sortKey) || 'name';
  list.sort((a, b) => compareImage(a, b, key) * dir || cmpStr(a.path, b.path));
  return list;
}

function gridColumns(width, thumb, pad, gap) {
  let inner = Math.max(thumb, (width || 0) - pad * 2);
  return Math.max(1, Math.floor((inner + gap) / (thumb + gap)));
}

function gridWindow(opts) {
  let pad = opts.pad == null ? 12 : opts.pad;
  let gap = opts.gap == null ? 10 : opts.gap;
  let overscan = opts.overscan == null ? 1 : opts.overscan;
  let thumb = Math.max(40, opts.thumb || 180);
  let width = opts.width || 0;
  // columnWidth is the whole viewport. Sidebars change the grid's width, not
  // how many columns the thumb size calls for.
  let span = opts.columnWidth == null ? width : opts.columnWidth;
  let cols = gridColumns(span, thumb, pad, gap);
  let gridWidth = width > 0 ? width : span;
  let inner = Math.max(0, gridWidth - pad * 2);
  let cell = (inner - gap * (cols - 1)) / cols;
  if (!(cell > 0)) cell = Math.max(1, inner || thumb);
  let rowStride = cell + gap;
  let count = opts.count || 0;
  let rows = count === 0 ? 0 : Math.ceil(count / cols);
  let totalH = rows === 0 ? 0 : pad * 2 + rows * cell + Math.max(0, rows - 1) * gap;
  let startRow = 0;
  let endRow = rows;
  if (rows) {
    let scrollTop = opts.scrollTop || 0;
    let viewHeight = opts.viewHeight == null ? 600 : opts.viewHeight;
    startRow = Math.max(0, Math.floor((scrollTop - pad) / rowStride) - overscan);
    endRow = Math.min(rows, Math.ceil((scrollTop + viewHeight - pad) / rowStride) + overscan);
  }
  let start = startRow * cols;
  let end = Math.min(count, endRow * cols);
  return {
    cols,
    cell,
    rowStride,
    rows,
    totalH,
    start,
    end,
    offset: pad + startRow * rowStride,
    pad,
    gap,
  };
}

function listWindow(opts) {
  let rowH = opts.rowH || 58;
  let overscan = opts.overscan == null ? 4 : opts.overscan;
  let count = opts.count || 0;
  let scrollTop = opts.scrollTop || 0;
  let viewHeight = opts.viewHeight == null ? 600 : opts.viewHeight;
  let start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  let end = Math.min(count, Math.ceil((scrollTop + viewHeight) / rowH) + overscan);
  if (count === 0) {
    start = 0;
    end = 0;
  }
  return {
    start,
    end,
    offset: start * rowH,
    totalH: count * rowH,
    rowH,
  };
}

function fitScale(boxW, boxH, imgW, imgH, rotation, mode, manualScale) {
  if (mode === 'actual') return 1;
  if (mode === 'manual') return manualScale > 0 ? manualScale : 1;
  let rot = ((rotation % 360) + 360) % 360;
  let swap = rot === 90 || rot === 270;
  let iw = swap ? imgH : imgW;
  let ih = swap ? imgW : imgH;
  if (!iw || !ih || !boxW || !boxH) return 1;
  let sx = boxW / iw;
  let sy = boxH / ih;
  if (mode === 'width') return sx;
  if (mode === 'fill') return Math.max(sx, sy);
  return Math.min(sx, sy);
}

// Keep the stage point (cx, cy) fixed while multiplying scale by factor.
function zoomAt(cx, cy, tx, ty, scale, factor, min, max) {
  let safe = scale > 0 ? scale : 1;
  let next = Math.min(max, Math.max(min, safe * factor));
  let k = next / safe;
  return {
    scale: next,
    tx: cx - (cx - tx) * k,
    ty: cy - (cy - ty) * k,
  };
}

function indexPool(images, opts) {
  if (opts && opts.scope === 'filtered') return visibleImages(images, opts);
  return visibleImages(images, {
    filter: '',
    recursive: true,
    sortKey: opts && opts.sortKey,
    sortDir: opts && opts.sortDir,
  });
}

// The next photo to index. Current sorting order is recomputed from the
// sort fields passed in, so a change applies on the following iteration.
function nextIndexTarget(images, opts) {
  let indexed = (opts && opts.indexed) || new Set();
  let blocked = (opts && opts.blocked) || new Set();
  let attempted = (opts && opts.attempted) || new Set();
  let byPath = new Map();
  for (let im of images || []) byPath.set(im.path, im);
  let paths = [];
  if (opts && opts.order === 'random') {
    for (let path of opts.randomPaths || []) {
      if (byPath.has(path)) paths.push(path);
    }
  } else {
    paths = indexPool(images, opts).map(im => im.path);
  }
  for (let path of paths) {
    if (indexed.has(path) || blocked.has(path) || attempted.has(path)) continue;
    return byPath.get(path);
  }
  return null;
}

function indexOutline(indexed, selected) {
  if (selected) return 'ring-2 ring-gold-300';
  if (indexed) return 'ring-2 ring-teal-400';
  return 'ring-1 ring-white/10 hover:ring-white/30';
}

function normalizeRelativePaths(paths) {
  let top = '';
  if (paths.length && paths.every(p => String(p).includes('/'))) {
    top = String(paths[0]).split('/')[0];
    if (!paths.every(p => p === top || String(p).startsWith(top + '/'))) top = '';
  }
  return {
    name: top || 'Selected files',
    paths: paths.map(p => (top ? String(p).slice(top.length + 1) : String(p))),
  };
}

export {
  IMAGE_EXT,
  SKIP_DIRS,
  extOf,
  isImageName,
  mimeFromExt,
  shouldSkipDir,
  formatBytes,
  formatDate,
  formatDims,
  plural,
  visibleImages,
  indexPool,
  nextIndexTarget,
  indexOutline,
  gridWindow,
  listWindow,
  fitScale,
  zoomAt,
  normalizeRelativePaths,
};
