// Minimal PNG decode for golden-image comparison, using only Node built-ins so
// the test suite needs no image library. Supports the 8-bit RGB/RGBA truecolour
// PNGs that Playwright's screenshot() emits, which is all we compare.
//
// Decoding is done with zlib inflate plus PNG's own filters; both are specified
// formats, so this is parsing, not guessing.
import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode a PNG buffer to { width, height, channels, data: Buffer RGBA }. */
export function decodePng(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(SIGNATURE), 'not a PNG (bad signature)');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      assert.equal(body[12], 0, 'interlaced PNGs are not supported');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  assert.ok(width > 0 && height > 0, 'missing IHDR');
  assert.equal(bitDepth, 8, `only 8-bit colour is supported, got ${bitDepth}`);
  const sourceChannels = { 2: 3, 6: 4 }[colorType];
  assert.ok(sourceChannels, `unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * sourceChannels;
  assert.equal(
    raw.length,
    height * (stride + 1),
    `IDAT size ${raw.length} disagrees with ${width}x${height}`,
  );

  const data = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const line = Buffer.from(raw.subarray(read, read + stride));
    read += stride;
    unfilterLine(filter, line, previous, sourceChannels);
    for (let x = 0; x < width; x++) {
      const from = x * sourceChannels;
      const to = (y * width + x) * 4;
      data[to] = line[from];
      data[to + 1] = line[from + 1];
      data[to + 2] = line[from + 2];
      data[to + 3] = sourceChannels === 4 ? line[from + 3] : 255;
    }
    previous = line;
  }
  return { width, height, channels: 4, data };
}

/** Reversible PNG line filters, per ISO/IEC 15948 table. */
function unfilterLine(filter, line, previous, channels) {
  if (filter === 0) return;
  for (let i = 0; i < line.length; i++) {
    const a = i >= channels ? line[i - channels] : 0;
    const b = previous[i];
    const c = i >= channels ? previous[i - channels] : 0;
    let prediction;
    switch (filter) {
      case 1: prediction = a; break;
      case 2: prediction = b; break;
      case 3: prediction = (a + b) >> 1; break;
      case 4: prediction = paeth(a, b, c); break;
      default: throw new Error(`unknown PNG filter type ${filter}`);
    }
    line[i] = (line[i] + prediction) & 0xff;
  }
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Fraction of pixels differing from the golden image by more than `threshold`
 * (0-255 per channel). Returns 1 when sizes mismatch, which callers treat as a
 * failure with its own message.
 */
export function differenceRatio(actual, golden, threshold = 8) {
  if (actual.width !== golden.width || actual.height !== golden.height) return 1;
  let differing = 0;
  const pixels = actual.width * actual.height;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    if (
      Math.abs(actual.data[o] - golden.data[o]) > threshold ||
      Math.abs(actual.data[o + 1] - golden.data[o + 1]) > threshold ||
      Math.abs(actual.data[o + 2] - golden.data[o + 2]) > threshold
    ) {
      differing += 1;
    }
  }
  return differing / pixels;
}
