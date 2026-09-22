import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  imageTypeOf,
  isInside,
  MAX_LOCAL_IMAGE_BYTES,
  pathFromImageUrl,
  resolveLocalImage,
} from '../../src/main/workspace/local-images.js';

let base: string;
let workspace: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'aw-images-'));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  mkdirSync(join(workspace, 'docs', 'screenshots'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workspace, 'docs', 'screenshots', 'home.png'), 'png-bytes');
  writeFileSync(join(workspace, 'notes.txt'), 'secret');
  writeFileSync(join(outside, 'private.png'), 'png-bytes');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('local image access', () => {
  it('serves an image inside an agent working directory', async () => {
    const result = await resolveLocalImage(join(workspace, 'docs', 'screenshots', 'home.png'), [workspace]);
    expect(result).toMatchObject({ ok: true, type: 'image/png' });
  });

  it('refuses an image outside every working directory', async () => {
    const result = await resolveLocalImage(join(outside, 'private.png'), [workspace]);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a path that climbs out with ..', async () => {
    const result = await resolveLocalImage(join(workspace, '..', 'outside', 'private.png'), [workspace]);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses files that are not images, even inside the workspace', async () => {
    const result = await resolveLocalImage(join(workspace, 'notes.txt'), [workspace]);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses relative paths and missing files', async () => {
    expect(await resolveLocalImage('docs/home.png', [workspace])).toMatchObject({ ok: false, status: 400 });
    expect(await resolveLocalImage(join(workspace, 'gone.png'), [workspace])).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('checks the real location behind a symlink', async () => {
    const link = join(workspace, 'sneaky.png');
    try {
      symlinkSync(join(outside, 'private.png'), link);
    } catch {
      return; // Creating symlinks needs extra rights on some Windows setups.
    }
    expect(await resolveLocalImage(link, [workspace])).toMatchObject({ ok: false, status: 403 });
  });

  it('decodes the path carried by an aw-image URL', () => {
    const path = 'D:/Dev/wardogs/docs/screenshots/home mobile.png';
    expect(pathFromImageUrl(`aw-image://local/${encodeURIComponent(path)}`)).toBe(path);
    expect(pathFromImageUrl('https://example.com/x.png')).toBeNull();
  });

  it('compares Windows paths case-insensitively', () => {
    expect(isInside('D:\\Dev', 'd:\\dev\\wardogs\\a.png', 'win32')).toBe(true);
    expect(isInside('D:\\Dev', 'D:\\Devil\\a.png', 'win32')).toBe(false);
  });

  it('knows which extensions are images', () => {
    expect(imageTypeOf('shot.PNG')).toBe('image/png');
    expect(imageTypeOf('shot.exe')).toBeNull();
    expect(MAX_LOCAL_IMAGE_BYTES).toBeGreaterThan(1024 * 1024);
  });
});
