import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import * as t from '../db/schema.js';

/**
 * Encrypts and decrypts secret material. In the app this is Electron's
 * `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on
 * Linux); tests supply their own. Nothing in this module ever writes a secret
 * in the clear.
 */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

/** The OS keychain as a cipher. Only usable after the Electron app is ready. */
export function safeStorageCipher(safeStorage: {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}): SecretCipher {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  };
}

export class SecretStorageUnavailableError extends Error {
  constructor() {
    super(
      'Secure credential storage is not available on this system, so the key was not saved. ' +
        'On Linux, install and unlock a keyring (GNOME Keyring or KWallet), then try again.',
    );
    this.name = 'SecretStorageUnavailableError';
  }
}

/**
 * A small vault of JSON blobs, one per integration (a provider's API key and
 * sensitive headers, an MCP server's token and environment, an external
 * agent's credential). Rows hold only ciphertext; callers hold only an id.
 *
 * The renderer never reads from here: IPC handlers report `hasApiKey`-style
 * booleans, and credentials are only decrypted in the main process at the
 * moment a request is made.
 */
export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: SecretCipher,
  ) {}

  /** Stores a value and returns its id. */
  create(value: Record<string, unknown>): string {
    const id = `secret:${randomUUID()}`;
    const now = Date.now();
    this.db
      .insert(t.secrets)
      .values({ id, ciphertext: this.seal(value), createdAt: now, updatedAt: now })
      .run();
    return id;
  }

  /** Replaces a value, creating it when the id is null. Returns the id. */
  put(id: string | null | undefined, value: Record<string, unknown>): string {
    if (!id || !this.exists(id)) return this.create(value);
    this.db
      .update(t.secrets)
      .set({ ciphertext: this.seal(value), updatedAt: Date.now() })
      .where(eq(t.secrets.id, id))
      .run();
    return id;
  }

  /** Decrypts a value. A missing or undecryptable secret reads as empty. */
  read<T extends Record<string, unknown>>(id: string | null | undefined): Partial<T> {
    if (!id) return {};
    const row = this.db.select().from(t.secrets).where(eq(t.secrets.id, id)).get();
    if (!row) return {};
    try {
      return JSON.parse(this.cipher.decrypt(Buffer.from(row.ciphertext, 'base64'))) as Partial<T>;
    } catch {
      // A profile copied to another machine cannot be decrypted with this OS
      // account's keys. Treat it as absent rather than crashing the caller.
      return {};
    }
  }

  delete(id: string | null | undefined): void {
    if (id) this.db.delete(t.secrets).where(eq(t.secrets.id, id)).run();
  }

  private exists(id: string): boolean {
    return !!this.db.select({ id: t.secrets.id }).from(t.secrets).where(eq(t.secrets.id, id)).get();
  }

  private seal(value: Record<string, unknown>): string {
    if (!this.cipher.isAvailable()) throw new SecretStorageUnavailableError();
    return this.cipher.encrypt(JSON.stringify(value)).toString('base64');
  }
}

/**
 * Removes every known secret value from a string before it is shown or logged.
 * Providers echo request details in error bodies surprisingly often.
 */
export function redact(text: string, secrets: Array<string | null | undefined>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) result = result.split(secret).join('••••');
  }
  // Belt and braces for bearer tokens that never passed through our hands.
  return result.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1••••');
}

/** Header names whose values are credentials and belong in the vault. */
export function isSensitiveHeader(name: string): boolean {
  return /authorization|api[-_]?key|token|secret|password|cookie|session/i.test(name);
}
