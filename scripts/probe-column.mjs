/** Measures the vertical extent of artwork inside one column of the sheet. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const path = resolve(process.argv[2]);
const colIndex = Number(process.argv[3] ?? 5);
const gridLeft = 32;
const pitch = 251;
const tile = 217;

const image = sharp(readFileSync(path)).removeAlpha();
const { width, height } = await image.metadata();
const { data } = await image.raw().toBuffer({ resolveWithObject: true });

const lum = (x, y) => {
  const i = (y * width + x) * 3;
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
};

const x0 = gridLeft + pitch * colIndex;
const x1 = Math.min(width - 1, x0 + tile - 1);

console.log(`column ${colIndex}: x ${x0}..${x1}`);
const means = [];
for (let y = 0; y < height; y += 1) {
  let sum = 0;
  for (let x = x0; x <= x1; x += 2) sum += lum(x, y);
  means.push(sum / Math.ceil((x1 - x0 + 1) / 2));
}

const sorted = [...means].sort((a, b) => a - b);
const bg = sorted[Math.floor(height * 0.2)];
const threshold = bg + 12;

let start = -1;
for (let y = 0; y < height; y += 1) {
  const bright = means[y] > threshold;
  if (bright && start === -1) start = y;
  if ((!bright || y === height - 1) && start !== -1) {
    const end = bright ? y : y - 1;
    if (end - start + 1 >= 6) console.log(`  band ${start}..${end}  (${end - start + 1}px)`);
    start = -1;
  }
}
