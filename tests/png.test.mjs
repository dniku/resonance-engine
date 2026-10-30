// Tests for the golden-image comparison itself. These matter: a comparison
// function that silently always returns 0 would make every screenshot test
// vacuously pass, so its behaviour is pinned here without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, differenceRatio } from './png.mjs';

const frame = (rgb, { width = 10, height = 10, alpha = 255 } = {}) => ({
  width,
  height,
  channels: 4,
  data: Buffer.from(Array(width * height).fill([rgb[0], rgb[1], rgb[2], alpha]).flat()),
});

test('identical images differ by nothing', () => {
  const image = frame([10, 20, 30]);
  assert.equal(differenceRatio(image, image), 0);
});

test('a single changed pixel is detected and scaled by area', () => {
  const base = frame([10, 20, 30]);
  const altered = frame([10, 20, 30]);
  altered.data[0] = 200;
  assert.ok(differenceRatio(base, altered) > 0, 'a colour change must register');
  assert.ok(Math.abs(differenceRatio(base, altered) - 1 / 100) < 1e-9);
});

test('differences below the per-channel threshold are tolerated', () => {
  const base = frame([10, 20, 30]);
  const near = frame([14, 21, 33]);
  assert.equal(differenceRatio(base, near, 8), 0);
  assert.ok(differenceRatio(base, near, 1) > 0.9, 'a strict threshold must reject it');
});

test('size mismatches are reported as fully different', () => {
  assert.equal(differenceRatio(frame([1, 2, 3]), frame([1, 2, 3], { width: 9 })), 1);
});

test('the alpha channel is not compared', () => {
  // Screenshots are composited; comparing alpha would flag invisible changes.
  assert.equal(differenceRatio(frame([9, 9, 9], { alpha: 255 }), frame([9, 9, 9], { alpha: 0 })), 0);
});

test('decodePng rejects inputs it cannot honour', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
});
