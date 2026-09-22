import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

/**
 * Serving local images to the renderer.
 *
 * Agents work on this machine and often reference what they produced by path
 * -- a screenshot, a chart -- as `![shot](D:/project/shot.png)`. The renderer
 * is sandboxed and cannot read the disk, so it asks for such files over the
 * `aw-image://` scheme instead, and this module decides what it may see.
 *
 * The rules are deliberately narrow: image files only, only from inside a
 * directory an agent is allowed to work in (or the default workspace
 * directory), never through a symlink that leads elsewhere, and never larger
 * than a screenshot plausibly is. Everything else is refused.
 */

export const LOCAL_IMAGE_SCHEME = 'aw-image';

export const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/** MIME type for an image path, or null when the extension is not an image. */
export function imageTypeOf(path: string): string | null {
  return IMAGE_TYPES[extname(path).toLowerCase()] ?? null;
}

/** The file path carried by an `aw-image://local/<encoded path>` URL. */
export function pathFromImageUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${LOCAL_IMAGE_SCHEME}:`) return null;
    const encoded = parsed.pathname.replace(/^\/+/, '');
    return encoded ? decodeURIComponent(encoded) : null;
  } catch {
    return null;
  }
}

/** True when `target` is `root` itself or sits somewhere beneath it. */
export function isInside(root: string, target: string, platform = process.platform): boolean {
  const a = platform === 'win32' ? root.toLowerCase() : root;
  const b = platform === 'win32' ? target.toLowerCase() : target;
  const rel = relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export type LocalImageResult =
  | { ok: true; path: string; type: string }
  | { ok: false; status: 400 | 403 | 404 | 413; reason: string };

/**
 * Resolves a requested path to a file the renderer may display, following
 * symlinks first so the containment check is made against the real location.
 */
export async function resolveLocalImage(
  requested: string,
  allowedRoots: string[],
): Promise<LocalImageResult> {
  if (!isAbsolute(requested)) return { ok: false, status: 400, reason: 'Path must be absolute.' };

  let real: string;
  try {
    real = await realpath(resolve(requested));
  } catch {
    return { ok: false, status: 404, reason: 'No such file.' };
  }

  const type = imageTypeOf(real);
  if (!type) return { ok: false, status: 403, reason: 'Not an image file.' };

  const roots = await Promise.all(
    allowedRoots.filter(Boolean).map((root) => realpath(resolve(root)).catch(() => null)),
  );
  if (!roots.some((root) => root !== null && isInside(root, real))) {
    return { ok: false, status: 403, reason: 'Outside every agent working directory.' };
  }

  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) return { ok: false, status: 404, reason: 'No such file.' };
  if (info.size > MAX_LOCAL_IMAGE_BYTES) return { ok: false, status: 413, reason: 'Image too large.' };

  return { ok: true, path: real, type };
}
