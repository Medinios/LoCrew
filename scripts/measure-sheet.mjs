/**
 * Finds the real tile bounds in the crew contact sheet.
 *
 * The artwork is bright against a near-black background, so projecting
 * brightness onto each axis gives clean runs: bright runs are tiles, dark runs
 * are gutters. Measuring beats guessing a grid, because the caption bands make
 * the vertical rhythm uneven.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const path = resolve(process.argv[2] ?? 'C:/Users/Sam/Downloads/crew.png');
const image = sharp(readFileSync(path)).removeAlpha();
const { width, height } = await image.metadata();
const { data } = await image.raw().toBuffer({ resolveWithObject: true });

const lum = (x, y) => {
  const i = (y * width + x) * 3;
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
};

/** Mean brightness of every column and row. */
const colMean = Array.from({ length: width }, (_, x) => {
  let sum = 0;
  for (let y = 0; y < height; y += 2) sum += lum(x, y);
  return sum / Math.ceil(height / 2);
});
const rowMean = Array.from({ length: height }, (_, y) => {
  let sum = 0;
  for (let x = 0; x < width; x += 2) sum += lum(x, y);
  return sum / Math.ceil(width / 2);
});

/** Contiguous runs above a threshold, ignoring slivers. */
function runs(values, threshold, minLength) {
  const out = [];
  let start = -1;
  values.forEach((v, i) => {
    if (v > threshold && start === -1) start = i;
    if ((v <= threshold || i === values.length - 1) && start !== -1) {
      const end = v <= threshold ? i - 1 : i;
      if (end - start + 1 >= minLength) out.push([start, end]);
      start = -1;
    }
  });
  return out;
}

const baseline = [...rowMean].sort((a, b) => a - b)[Math.floor(height * 0.15)];
const threshold = baseline + 14;

console.log(`sheet ${width}x${height}  background~${baseline.toFixed(1)}  threshold ${threshold.toFixed(1)}`);
console.log('\ncolumns (tile x-ranges):');
const cols = runs(colMean, threshold, Math.floor(width / 20));
for (const [a, b] of cols) console.log(`  ${a}..${b}  (${b - a + 1}px)`);

console.log('\nrows (bright bands: tile art, then caption text):');
const rows = runs(rowMean, threshold, 8);
for (const [a, b] of rows) console.log(`  ${a}..${b}  (${b - a + 1}px)`);
