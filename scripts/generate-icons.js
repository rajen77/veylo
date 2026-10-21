#!/usr/bin/env node
'use strict';

/**
 * Generates the client's icon set from the project's single icon source,
 * veylo.png, by decoding it and resizing it to every required size.
 *
 * Both the decoder and the encoder are written by hand with zlib so that the
 * build has no image library dependency and works inside a minimal Flatpak
 * build sandbox.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SOURCE = path.join(__dirname, '..', 'veylo.png');
const OUT_DIR = path.join(__dirname, '..', 'assets');
const BUILD_DIR = path.join(__dirname, '..', 'build', 'icons');
const FLATPAK_ICON_NAME = 'io.github.veylo.Client.png';

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes an 8-bit, non-interlaced RGB or RGBA PNG into raw RGBA rows.
 *
 * A minimal reader keeps the build free of image library dependencies, which
 * matters inside the Flatpak build sandbox. Any other PNG format is rejected
 * with a clear error rather than silently mis-decoded.
 */
function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) {
    throw new Error(`${SOURCE} is not a PNG file`);
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!width || !height) throw new Error(`${SOURCE} has no IHDR chunk`);
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(
      `${SOURCE}: unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType}, `
      + `interlace=${interlace}); expected 8-bit RGB/RGBA, non-interlaced`,
    );
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) {
    throw new Error(`${SOURCE}: pixel data is truncated`);
  }

  // Undo the per-scanline filters in place; left/up neighbours are the already
  // reconstructed values, as the PNG spec requires.
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const byte = raw[rowStart + x];
      const left = x >= channels ? pixels[out + x - channels] : 0;
      const up = y > 0 ? pixels[out - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[out - stride + x - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = byte; break;
        case 1: value = byte + left; break;
        case 2: value = byte + up; break;
        case 3: value = byte + ((left + up) >> 1); break;
        case 4: value = byte + paeth(left, up, upLeft); break;
        default: throw new Error(`${SOURCE}: unsupported PNG filter type ${filter}`);
      }
      pixels[out + x] = value & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: pixels };

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

/**
 * Area-average resize with premultiplied alpha, so transparent corners of the
 * icon do not bleed their colour into the surrounding pixels on downscale.
 * Fractional source rectangles keep odd sizes (22, 24) free of aliasing.
 */
function resizeRgba(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;

  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = dy * yr;
    const y1 = Math.min((dy + 1) * yr, sh);
    const ys0 = Math.floor(y0);
    const ys1 = Math.min(Math.ceil(y1), sh);

    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = dx * xr;
      const x1 = Math.min((dx + 1) * xr, sw);
      const xs0 = Math.floor(x0);
      const xs1 = Math.min(Math.ceil(x1), sw);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;

      for (let y = ys0; y < ys1; y += 1) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = xs0; x < xs1; x += 1) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (y * sw + x) * 4;
          const wa = w * src[i + 3];
          r += src[i] * wa;
          g += src[i + 1] * wa;
          b += src[i + 2] * wa;
          a += wa;
          weight += w;
        }
      }

      const o = (dy * dw + dx) * 4;
      if (a > 0) {
        dst[o] = Math.round(r / a);
        dst[o + 1] = Math.round(g / a);
        dst[o + 2] = Math.round(b / a);
        dst[o + 3] = Math.min(255, Math.round(a / weight));
      }
    }
  }

  return dst;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type: none
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePng(filePath, rgba, size) {
  fs.writeFileSync(filePath, encodePng(rgba, size));
  return filePath;
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Icon source not found: ${SOURCE}`);
    process.exit(1);
  }

  const source = decodePng(fs.readFileSync(SOURCE));
  const iconAt = (size) => resizeRgba(source.rgba, source.width, source.height, size, size);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  // Electron's dock/tray icon.
  writePng(path.join(OUT_DIR, 'tray.png'), iconAt(22), 22);
  writePng(path.join(OUT_DIR, 'icon.png'), iconAt(512), 512);

  // Icon theme sizes. electron-builder expects flat <size>.png files directly
  // inside the icons directory, while Flatpak wants <size>x<size>/<app-id>.png,
  // so both layouts are written from the same source.
  const sizes = [16, 22, 24, 32, 48, 64, 128, 256, 512];
  for (const size of sizes) {
    const dir = path.join(BUILD_DIR, `${size}x${size}`);
    fs.mkdirSync(dir, { recursive: true });
    const icon = writePng(path.join(dir, 'veylo.png'), iconAt(size), size);
    fs.copyFileSync(icon, path.join(BUILD_DIR, `${size}.png`));
  }

  // Flatpak looks for the app id under share/icons/hicolor.
  const flatpakIconDir = path.join(__dirname, '..', 'flatpak', 'icons');
  fs.mkdirSync(flatpakIconDir, { recursive: true });
  fs.copyFileSync(path.join(BUILD_DIR, '512x512', 'veylo.png'), path.join(flatpakIconDir, FLATPAK_ICON_NAME));

  console.log(`Generated icons in ${OUT_DIR}, ${BUILD_DIR} and ${flatpakIconDir}`);
}

main();
