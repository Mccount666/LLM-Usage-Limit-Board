// Generates the application icon (multi-size .ico) and the tray PNG.
//
// Reproducible on purpose: the icon is code, not a binary someone has to
// re-draw. Run `npm run icon` after changing the drawing.
//
// Design: a dark rounded panel with three green bars — the same motif as the
// widget (panel #14161c, accent #4ade80).
//
// Rendered with 4x supersampling then box-averaged, which is what gives clean
// edges without pulling in a canvas dependency.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PANEL = [20, 22, 28, 255]; // #14161c
const BORDER = [74, 82, 96, 255];
const BAR = [74, 222, 128, 255]; // #4ade80
const BAR_DIM = [34, 160, 92, 255];

const SS = 4; // supersample factor

/** Coverage-based drawing at a single size, returns RGBA rows. */
function drawRGBA(size) {
  const S = size * SS;
  const hi = new Uint8Array(S * S * 4);
  const radius = S * 0.22;

  const insideRounded = (x, y) => {
    const r = radius;
    const cx = Math.min(Math.max(x, r), S - r);
    const cy = Math.min(Math.max(y, r), S - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };

  // bars: [x0, x1, y0] in fractions of the canvas
  const barsFrac = [
    [0.26, 0.42, 0.52],
    [0.44, 0.60, 0.36],
    [0.62, 0.78, 0.22],
  ];
  const baseline = 0.78;
  const bars = barsFrac.map(([x0, x1, y0]) => ({
    x0: x0 * S,
    x1: x1 * S,
    y0: y0 * S,
    y1: baseline * S,
  }));

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (!insideRounded(x + 0.5, y + 0.5)) continue; // transparent outside
      let px = PANEL;
      // 1.5px (in target space) inner border
      if (!insideRounded(x + 0.5, y + 0.5 + 0) && false) px = BORDER;
      const edge = Math.min(x, y, S - 1 - x, S - 1 - y);
      if (edge < 1.5 * SS) px = BORDER;
      for (let b = 0; b < bars.length; b++) {
        const r = bars[b];
        if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) {
          px = b === 2 ? BAR : b === 1 ? BAR : BAR;
          if (b === 0) px = BAR_DIM;
          break;
        }
      }
      hi[i] = px[0]; hi[i + 1] = px[1]; hi[i + 2] = px[2]; hi[i + 3] = px[3];
    }
  }

  // box-average down to the target size (premultiplied, to avoid dark fringes)
  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * S + (x * SS + dx)) * 4;
          const al = hi[i + 3] / 255;
          r += hi[i] * al; g += hi[i + 1] * al; b += hi[i + 2] * al; a += hi[i + 3];
        }
      }
      const aAvg = a / n;
      const o = (y * size + x) * 4;
      if (aAvg === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
      const wsum = a / 255 || 1;
      out[o] = Math.round(r / wsum);
      out[o + 1] = Math.round(g / wsum);
      out[o + 2] = Math.round(b / wsum);
      out[o + 3] = Math.round(aAvg);
    }
  }
  return out;
}

// ---- PNG encoding --------------------------------------------------------
function crc32Table() {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crc32Table();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  let crc = 0xffffffff;
  for (const b of Buffer.concat([t, data])) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, t, data, c]);
}
function encodePNG(rgba, size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO container -------------------------------------------------------
// PNG-compressed entries are supported by Windows Vista+ and required to carry
// a 256x256 frame (electron-builder rejects icons without one).
function buildICO(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + dir.length;
  frames.forEach((f, i) => {
    const o = i * 16;
    dir[o] = f.size === 256 ? 0 : f.size;
    dir[o + 1] = f.size === 256 ? 0 : f.size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);   // planes
    dir.writeUInt16LE(32, o + 6);  // bpp
    dir.writeUInt32LE(f.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += f.png.length;
  });
  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

// ---- emit ---------------------------------------------------------------
const root = path.join(__dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const frames = SIZES.map((size) => ({ size, png: encodePNG(drawRGBA(size), size) }));

const ico = buildICO(frames);
for (const dir of [path.join(root, 'build'), path.join(root, 'src', 'assets')]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico);
}

// Tray icon (16x16 PNG, inlined into main.js so packaging needs no asset path)
const tray = frames.find((f) => f.size === 16).png;
fs.writeFileSync(path.join(root, 'src', 'assets', 'tray.png'), tray);

console.log('build/icon.ico + src/assets/icon.ico  ' + ico.length + ' bytes, frames: ' + SIZES.join('/'));
console.log('tray.png base64 (for the inline constant):');
console.log(tray.toString('base64'));
