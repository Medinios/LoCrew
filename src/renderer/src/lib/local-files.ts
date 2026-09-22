/**
 * Local file references in agent messages.
 *
 * Agents run on this machine, so they point at what they made by path:
 * `D:/project/shot.png`, `file:///D:/project/shot.png`, or a path relative to
 * their working directory. The sandboxed renderer cannot open any of those, so
 * images are fetched over the main process's `aw-image://` scheme (which only
 * serves image files from agent working directories) and other files become
 * copy-the-path chips.
 */

const SCHEME = 'aw-image';

/** `file:///C:/x/y.png` -> `C:\x\y.png`; POSIX paths keep their leading slash. */
export function fileUrlToPath(href: string): string {
  try {
    const decoded = decodeURIComponent(new URL(href).pathname);
    return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1).replace(/\//g, '\\') : decoded;
  } catch {
    return href.replace(/^file:\/+/i, '');
  }
}

/**
 * The absolute local path a markdown URL refers to, or null when it is a web
 * URL, an in-page anchor, or a relative path with nothing to resolve against.
 */
export function localPathOf(url: string, baseDir?: string): string | null {
  const value = url.trim();
  if (!value || value.startsWith('#')) return null;
  if (/^file:/i.test(value)) return fileUrlToPath(value);
  if (/^[A-Za-z]:[\\/]/.test(value)) return value; // D:/x or D:\x
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // http:, data:, mailto: ...
  if (value.startsWith('/') || value.startsWith('\\')) return value;
  if (!baseDir) return null;
  const separator = baseDir.includes('\\') ? '\\' : '/';
  const trimmedBase = baseDir.replace(/[\\/]+$/, '');
  const relativePart = value.replace(/^\.[\\/]/, '').replace(/[\\/]/g, separator);
  return `${trimmedBase}${separator}${relativePart}`;
}

/** URL the renderer may load a local image from. */
export function localImageUrl(path: string): string {
  return `${SCHEME}://local/${encodeURIComponent(path)}`;
}

/** `file:` URL for a local path, which the transcript renders as a chip. */
export function pathToFileUrl(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  return `file://${normalised.startsWith('/') ? '' : '/'}${encodeURI(normalised)}`;
}

export function isLocalImageUrl(url: string | undefined): boolean {
  return !!url && url.startsWith(`${SCHEME}:`);
}
