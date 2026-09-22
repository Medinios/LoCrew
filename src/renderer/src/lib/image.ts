/** An image ready to send with a message. */
export interface OutgoingImage {
  id: string;
  name: string;
  /** Base64, without the data-URL prefix. */
  data: string;
  mimeType: string;
  /** For the composer's thumbnail. */
  previewUrl: string;
  sizeBytes: number;
}

/** Types the app sends as they are; anything else decodable is re-encoded. */
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Longest side sent to agents. Larger images are scaled down first. */
const MAX_SEND_DIMENSION = 2048;
/** Providers cap images around 5 MB; staying under that keeps every agent able to see them. */
const MAX_SEND_BYTES = 4.5 * 1024 * 1024;

/**
 * Makes a pasted or dropped image ready for any agent: kept as it is when it
 * is already a small PNG, JPEG, GIF or WebP; otherwise scaled to fit 2048 px
 * and re-encoded (PNG for screenshots when that stays small, else JPEG).
 */
export async function prepareImageForSending(file: File): Promise<OutgoingImage> {
  if (file.size > MAX_INPUT_BYTES) throw new Error(`${file.name || 'That image'} is larger than 20 MB.`);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name || 'That file'} could not be read as an image.`);
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    let blob: Blob = file;
    if (!SENDABLE.has(file.type) || longest > MAX_SEND_DIMENSION || file.size > MAX_SEND_BYTES) {
      const scale = Math.min(1, MAX_SEND_DIMENSION / longest);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not process the image.');
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      const encode = (type: string, quality?: number) =>
        new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
      const keepsDetail = file.type === 'image/png' || file.type === 'image/bmp' || file.type === 'image/gif';
      const png = keepsDetail ? await encode('image/png') : null;
      const chosen =
        png && png.size <= MAX_SEND_BYTES ? png : ((await encode('image/jpeg', 0.9)) ?? (await encode('image/jpeg', 0.75)));
      if (!chosen) throw new Error('Could not process the image.');
      blob = chosen.size > MAX_SEND_BYTES ? ((await encode('image/jpeg', 0.7)) ?? chosen) : chosen;
    }

    const dataUrl = await readAsDataUrl(blob);
    const mimeType = blob.type || file.type;
    return {
      id: crypto.randomUUID(),
      name: file.name || `pasted-image.${mimeType.split('/')[1] ?? 'png'}`,
      data: dataUrl.slice(dataUrl.indexOf(',') + 1),
      mimeType,
      previewUrl: dataUrl,
      sizeBytes: blob.size,
    };
  } finally {
    bitmap.close();
  }
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

/** Image files among pasted or dropped items. */
export function imageFilesIn(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.files].filter((file) => file.type.startsWith('image/'));
}

/** Formats a browser can decode and the settings schema accepts once re-encoded. */
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';

/** Largest file worth decoding. The result is always small; this only guards memory. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Encoded size ceiling, under the schema's limit with room to spare. */
const MAX_OUTPUT_CHARS = 300_000;

/**
 * Turns a picked image into a small square avatar: centre-cropped, scaled to
 * `size` pixels and re-encoded as WebP (JPEG as a fallback). Re-encoding also
 * strips metadata such as EXIF location from photos.
 */
export async function squareAvatarDataUrl(file: Blob, size = 256): Promise<string> {
  if (file.size > MAX_INPUT_BYTES) throw new Error('That image is larger than 20 MB.');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be read as an image. Use PNG, JPEG, WebP or GIF.');
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process the image.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);

    for (const [type, quality] of [
      ['image/webp', 0.9],
      ['image/jpeg', 0.88],
      ['image/jpeg', 0.7],
    ] as const) {
      const url = canvas.toDataURL(type, quality);
      // Browsers that cannot encode a type quietly return PNG instead.
      if (url.startsWith(`data:${type};`) && url.length <= MAX_OUTPUT_CHARS) return url;
    }
    throw new Error('Could not make that image small enough.');
  } finally {
    bitmap.close();
  }
}
