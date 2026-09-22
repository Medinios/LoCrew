/**
 * Slices the crew contact sheet into individual portraits.
 *
 *   npm run crew:slice <sheet.png> [--cols 6] [--rows 3] [--size 256] [--inset 4]
 *
 * The sheet is a grid of rounded-square portraits with a name and role caption
 * under each. Rather than assume an even grid -- the caption bands make the
 * vertical rhythm uneven, and a naive grid leaves dark padding around every
 * tile -- this measures the artwork.
 *
 * Tiles are bright against a near-black background, so projecting brightness
 * onto each axis gives clean runs: bright runs are tiles, dark runs are
 * gutters. Row bands give the exact tile size and vertical positions. Columns
 * are derived from the outermost bright pixels plus the column count, because
 * a tile with dark edges (a black hat, a night sky) under-reports its own
 * width and would skew a per-run measurement.
 *
 * Output: src/renderer/src/assets/crew/<id>.png, named from the roster in
 * src/renderer/src/lib/crew.ts, read left to right, top to bottom.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outDir = join(projectRoot, 'src/renderer/src/assets/crew');

/** Keep in step with CREW_PORTRAITS in src/renderer/src/lib/crew.ts. */
const IDS = [
  'blackbeard', 'red-raven', 'ghost', 'polly', 'old-salt', 'capn-mira',
  'kraken', 'coco', 'iron-jack', 'scarlett', 'navigator', 'zen',
  'sharky', 'rusty', 'skipper', 'shadow', 'whiskers', 'treasure',
];

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}

const sheetPath = process.argv[2];
if (!sheetPath) {
  console.error('Usage: npm run crew:slice <sheet.png> [--cols 6] [--rows 3] [--size 256]');
  process.exit(1);
}

const absoluteSheet = resolve(sheetPath);
if (!existsSync(absoluteSheet)) {
  console.error(`No such file: ${absoluteSheet}`);
  console.error('Save the contact sheet there first, or pass the path you used.');
  process.exit(1);
}

const cols = arg('cols', 6);
const rows = arg('rows', 3);
const size = arg('size', 256);
/** Pixels shaved from each edge, to drop the tile's own rounded border. */
const inset = arg('inset', 4);

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('This script needs sharp. Install it with:\n  npm i -D sharp');
  process.exit(1);
}

const buffer = readFileSync(absoluteSheet);
const image = sharp(buffer).removeAlpha();
const { width, height } = await image.metadata();
const { data } = await image.raw().toBuffer({ resolveWithObject: true });

const luminance = (x, y) => {
  const i = (y * width + x) * 3;
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
};

const rowMean = Array.from({ length: height }, (_, y) => {
  let sum = 0;
  for (let x = 0; x < width; x += 2) sum += luminance(x, y);
  return sum / Math.ceil(width / 2);
});
const colMean = Array.from({ length: width }, (_, x) => {
  let sum = 0;
  for (let y = 0; y < height; y += 2) sum += luminance(x, y);
  return sum / Math.ceil(height / 2);
});

const sortedRows = [...rowMean].sort((a, b) => a - b);
const background = sortedRows[Math.floor(height * 0.15)];
const threshold = background + 14;

function runs(values, minLength) {
  const out = [];
  let start = -1;
  values.forEach((value, index) => {
    if (value > threshold && start === -1) start = index;
    if ((value <= threshold || index === values.length - 1) && start !== -1) {
      const end = value <= threshold ? index - 1 : index;
      if (end - start + 1 >= minLength) out.push([start, end]);
      start = -1;
    }
  });
  return out;
}

// Art rows are tall; caption bands are ~13px and filtered out by minLength.
const rowBands = runs(rowMean, Math.floor(height / (rows * 4))).filter(
  ([a, b]) => b - a + 1 > height / (rows * 3),
);

if (rowBands.length !== rows) {
  console.error(
    `Expected ${rows} rows of artwork but measured ${rowBands.length}. ` +
      'Pass --rows to override, or check the sheet.',
  );
  process.exit(1);
}

const tile = Math.round(
  rowBands.reduce((sum, [a, b]) => sum + (b - a + 1), 0) / rowBands.length,
);

// Outermost bright columns bound the whole grid; the pitch follows from the
// column count. This is immune to a dark-edged tile mis-measuring itself.
const colRuns = runs(colMean, 8);
const gridLeft = colRuns[0]?.[0] ?? 0;
const gridRight = colRuns.at(-1)?.[1] ?? width - 1;
const span = gridRight - gridLeft + 1;
const pitchX = cols > 1 ? (span - tile) / (cols - 1) : 0;

console.log(
  `sheet ${width}x${height} | tile ${tile}px | grid x ${gridLeft}..${gridRight} ` +
    `| pitch ${pitchX.toFixed(1)}`,
);

mkdirSync(outDir, { recursive: true });

let written = 0;
for (let row = 0; row < rows; row += 1) {
  for (let col = 0; col < cols; col += 1) {
    const id = IDS[row * cols + col];
    if (!id) continue;

    const left = Math.round(gridLeft + pitchX * col) + inset;
    const top = rowBands[row][0] + inset;
    const side = Math.min(tile - inset * 2, width - left, height - top);

    await sharp(buffer)
      .extract({ left, top, width: side, height: side })
      .resize(size, size, { fit: 'cover' })
      .png({ compressionLevel: 9 })
      .toFile(join(outDir, `${id}.png`));

    written += 1;
    console.log(`  ${id.padEnd(12)} (${left},${top}) ${side}x${side} -> ${size}x${size}`);
  }
}

writeFileSync(
  join(outDir, 'README.md'),
  [
    '# Crew portraits',
    '',
    `Sliced from \`${sheetPath}\` by \`scripts/slice-crew.mjs\`.`,
    `Detected tile ${tile}px, output ${size}x${size}.`,
    '',
    'Re-run `npm run crew:slice <sheet.png>` to regenerate. Ids must match',
    'CREW_PORTRAITS in `src/renderer/src/lib/crew.ts`.',
    '',
    '> Check the licence of the source artwork before publishing this repo.',
    '',
  ].join('\n'),
);

console.log(`\nWrote ${written} portraits to src/renderer/src/assets/crew/`);
