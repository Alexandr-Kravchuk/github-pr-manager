// Generates build/icon.png (1024×1024) — a small "list of PR cards" glyph on a
// dark rounded square, matching the dashboard's accent colors. Dependency-free
// (Node + zlib only); electron-builder derives the .icns/.ico from this PNG.
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const buf = new Uint8Array(SIZE * SIZE * 4); // RGBA, transparent by default

function compositePx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return;
  const i = (y * SIZE + x) * 4;
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

// Distance from point to a rounded-rect's outside (0 inside). Used for crisp,
// lightly anti-aliased rounded corners.
function roundRectCoverage(px, py, x0, y0, x1, y1, radius) {
  const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (px < x0 || px > x1 || py < y0 || py > y1) return 0;
  // 1 inside, fades over ~1.5px at the rounded edge.
  return Math.max(0, Math.min(1, radius - dist + 0.75));
}

function fillRoundRect(x0, y0, x1, y1, radius, [r, g, b, a = 255]) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const cov = roundRectCoverage(x + 0.5, y + 0.5, x0, y0, x1, y1, radius);
      if (cov > 0) compositePx(x, y, r, g, b, Math.round(a * cov));
    }
  }
}

// Background: rounded square with a subtle vertical gradient.
for (let y = 0; y < SIZE; y++) {
  const t = y / SIZE;
  const r = Math.round(27 - t * 16); // #1b… -> #0b…
  const g = Math.round(27 - t * 16);
  const b = Math.round(32 - t * 19);
  for (let x = 0; x < SIZE; x++) {
    const cov = roundRectCoverage(x + 0.5, y + 0.5, 8, 8, SIZE - 8, SIZE - 8, 180);
    if (cov > 0) compositePx(x, y, r, g, b, Math.round(255 * cov));
  }
}

// Three PR "cards", each with a colored left accent bar + two text lines.
const ACCENTS = [
  [52, 211, 153], // emerald
  [251, 191, 36], // amber
  [56, 189, 248], // sky
];
const cardX0 = 232;
const cardX1 = 792;
const cardH = 150;
const firstY = 236;
const gap = 52;

for (let c = 0; c < 3; c++) {
  const y0 = firstY + c * (cardH + gap);
  const y1 = y0 + cardH;
  // Card body
  fillRoundRect(cardX0, y0, cardX1, y1, 26, [37, 37, 43, 255]);
  // Left accent bar
  fillRoundRect(cardX0 + 22, y0 + 26, cardX0 + 58, y1 - 26, 16, [...ACCENTS[c], 255]);
  // Two "text" lines
  fillRoundRect(cardX0 + 92, y0 + 42, cardX0 + 430, y0 + 70, 14, [113, 113, 122, 255]);
  fillRoundRect(cardX0 + 92, y0 + 90, cardX0 + 330, y0 + 112, 11, [82, 82, 91, 255]);
}

// --- PNG encode (RGBA, no external deps) ---
function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// 10,11,12 = 0 (deflate / adaptive / no interlace)

// Raw scanlines, each prefixed with filter byte 0.
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0;
  buf.subarray(y * SIZE * 4, (y + 1) * SIZE * 4).forEach((v, i) => {
    raw[y * (1 + SIZE * 4) + 1 + i] = v;
  });
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../build");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "icon.png");
fs.writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${png.length} bytes, ${SIZE}x${SIZE})`);
