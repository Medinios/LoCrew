/**
 * Renders resources/icon.svg to resources/icon.png (1024x1024, transparent).
 *
 * electron-builder takes resources/icon.png (its buildResources folder) and
 * derives the Windows .ico, macOS .icns and Linux icons from it, so this PNG
 * is the single source for every platform. Run with `npm run icons`.
 *
 * Uses Electron's own offscreen renderer, so no image tooling is needed.
 */
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SIZE = 1024;
const root = join(__dirname, '..');
const source = join(root, 'resources', 'icon.svg');
const target = join(root, 'resources', 'icon.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = readFileSync(source, 'utf8');
  const html = `<!doctype html><html style="background:transparent;overflow:hidden"><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Give the offscreen renderer a frame to paint.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = (await window.webContents.capturePage()).resize({ width: SIZE, height: SIZE, quality: 'best' });
  writeFileSync(target, image.toPNG());
  console.log(`Wrote ${target} (${image.getSize().width}x${image.getSize().height})`);
  app.quit();
});
