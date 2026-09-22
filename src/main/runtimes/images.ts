import { readFile } from 'node:fs/promises';
import type { ContextImage } from './types.js';

export interface LoadedImage extends ContextImage {
  bytes: Buffer;
}

/**
 * Reads a turn's images from disk. A file that has gone missing (deleted by
 * hand, say) is reported rather than failing the whole run, so the runtime can
 * tell the agent it existed but is no longer available.
 */
export async function loadImages(
  images: ContextImage[],
  read: (path: string) => Promise<Buffer> = (path) => readFile(path),
): Promise<{ loaded: LoadedImage[]; missing: ContextImage[] }> {
  const loaded: LoadedImage[] = [];
  const missing: ContextImage[] = [];
  for (const image of images) {
    try {
      loaded.push({ ...image, bytes: await read(image.path) });
    } catch {
      missing.push(image);
    }
  }
  return { loaded, missing };
}

/** A line for the prompt about images that could not be read. */
export function missingImagesNote(missing: ContextImage[]): string {
  return missing.length
    ? `\n\n[${missing.length === 1 ? 'This image is' : 'These images are'} no longer available: ${missing.map((m) => m.name).join(', ')}]`
    : '';
}
