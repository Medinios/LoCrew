import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageAttachment } from '../../shared/types.js';
import type { Store } from '../db/store.js';

/**
 * Images sent with a message.
 *
 * The renderer hands over raw bytes; everything that matters is decided here:
 * the type is read from the file's own signature (a PNG called "photo.jpg" is
 * a PNG, and an SVG or anything else is refused), sizes and counts are
 * bounded, and the file is written under the app's data folder with a
 * generated name. The user's filename is kept for display only.
 */

export const MAX_IMAGES_PER_MESSAGE = 8;
/** Per image. Providers cap images around 5 MB; the renderer shrinks larger pastes first. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 30 * 1024 * 1024;

type ImageType = MessageAttachment['mimeType'];

const EXTENSION: Record<ImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** An image that passed validation and is ready to store. */
export interface PreparedImage {
  bytes: Buffer;
  mimeType: ImageType;
  name: string;
}

/** The image type a file really is, from its first bytes, or null. */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  const at = (offset: number, signature: number[]) => signature.every((byte, i) => bytes[offset + i] === byte);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

/**
 * A display name that cannot carry a path or control characters, with an
 * extension matching what the file actually is.
 */
export function displayName(requested: string, mimeType: ImageType): string {
  // eslint-disable-next-line no-control-regex
  const base = (requested.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 100) || 'image';
  return `${stem}.${EXTENSION[mimeType]}`;
}

/** Validates what the renderer sent. Throws a plain-language error on the first problem. */
export function prepareImages(inputs: Array<{ name: string; data: string }>): PreparedImage[] {
  if (inputs.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`A message can carry at most ${MAX_IMAGES_PER_MESSAGE} images.`);
  }
  let total = 0;
  return inputs.map((input, index) => {
    const bytes = Buffer.from(input.data, 'base64');
    const label = input.name || `Image ${index + 1}`;
    if (!bytes.length) throw new Error(`${label} is empty.`);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${label} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    total += bytes.length;
    if (total > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error(`These images add up to more than ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MB.`);
    }
    const mimeType = detectImageType(bytes);
    if (!mimeType) throw new Error(`${label} is not a PNG, JPEG, GIF or WebP image.`);
    return { bytes, mimeType, name: displayName(input.name, mimeType) };
  });
}

/** Writes validated images to disk and records them as a message's attachments. */
export class ImageAttachmentStore {
  constructor(
    private readonly root: string,
    private readonly store: Store,
  ) {}

  /** The folder every attachment lives under, for the image scheme's allow-list. */
  get directory(): string {
    return this.root;
  }

  save(conversationId: string, messageId: string, images: PreparedImage[]): MessageAttachment[] {
    if (!images.length) return [];
    const folder = this.folderFor(conversationId);
    mkdirSync(folder, { recursive: true });

    const now = Date.now();
    const attachments = images.map((image): MessageAttachment => {
      const id = `att:${randomUUID()}`;
      const path = join(folder, `${id.slice(4)}.${EXTENSION[image.mimeType]}`);
      writeFileSync(path, image.bytes, { flag: 'wx' });
      return {
        id,
        messageId,
        kind: 'image',
        mimeType: image.mimeType,
        name: image.name,
        path,
        sizeBytes: image.bytes.length,
        createdAt: now,
      };
    });
    this.store.insertAttachments(attachments, conversationId);
    return attachments;
  }

  /** Deletes a conversation's files; its rows go with the conversation. */
  removeConversation(conversationId: string): void {
    rmSync(this.folderFor(conversationId), { recursive: true, force: true });
  }

  private folderFor(conversationId: string): string {
    // Conversation ids are generated ("conv:<uuid>"); keep only safe characters regardless.
    return join(this.root, conversationId.replace(/[^A-Za-z0-9_-]/g, '_'));
  }
}
