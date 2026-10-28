import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Encrypted, file-backed JSON store — the "local vault" for a single-user,
 * offline deployment.
 *
 * The chain's non-negotiable rule stands: secrets are NEVER written to
 * PostgreSQL. When credentials are entered in the UI instead of `.env` they
 * land here — an AES-256-GCM envelope in the data directory, outside the
 * database and outside the repo.
 *
 * THREAT MODEL (be honest about it): the key file lives beside the ciphertext
 * unless a key is supplied from outside (`CREDENTIAL_STORE_KEY`). That protects
 * against casual disclosure — DB dumps, `pg_dump` backups, adminer, screen
 * shares, an accidental `git add` — not against someone who can already read
 * the data directory. For a laptop-local command center that is the right
 * trade; for a shared host, pass a key from an external secret manager.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** On-disk shape. Versioned so the format can change without losing data. */
interface Envelope {
  v: 1;
  alg: typeof ALGORITHM;
  iv: string;
  tag: string;
  data: string;
}

export interface EncryptedJsonStoreOptions {
  /** Absolute path of the encrypted document. */
  filePath: string;
  /** 32-byte key as hex or base64. When omitted, a key file is used/generated. */
  key?: string;
  /** Key file location. Default: `<filePath>.key`. */
  keyPath?: string;
}

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Credential store key must be ${KEY_BYTES} bytes (hex or base64), got ${key.length}`);
  }
  return key;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export class EncryptedJsonStore<T> {
  private readonly filePath: string;
  private readonly keyPath: string;
  private readonly explicitKey?: string;
  private key?: Buffer;

  constructor(options: EncryptedJsonStoreOptions) {
    this.filePath = options.filePath;
    this.keyPath = options.keyPath ?? `${options.filePath}.key`;
    this.explicitKey = options.key?.trim() || undefined;
  }

  /** Where the encrypted document lives (for logs / diagnostics). */
  get path(): string {
    return this.filePath;
  }

  /** True when the key comes from configuration rather than the local key file. */
  get keyIsExternal(): boolean {
    return this.explicitKey !== undefined;
  }

  /** Resolve the encryption key: config -> existing key file -> freshly generated. */
  private async resolveKey(): Promise<Buffer> {
    if (this.key) return this.key;
    if (this.explicitKey) {
      this.key = parseKey(this.explicitKey);
      return this.key;
    }
    try {
      this.key = parseKey(await readFile(this.keyPath, 'utf8'));
      return this.key;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    const generated = randomBytes(KEY_BYTES);
    await mkdir(dirname(this.keyPath), { recursive: true });
    // 0600: owner-only. A no-op on Windows, which relies on directory ACLs.
    await writeFile(this.keyPath, generated.toString('base64'), { mode: 0o600 });
    this.key = generated;
    return generated;
  }

  /** Decrypt the document, or null when nothing has been written yet. */
  async read(): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }

    const envelope = JSON.parse(raw) as Envelope;
    if (envelope.v !== 1 || envelope.alg !== ALGORITHM) {
      throw new Error(`Unsupported credential store format in ${this.filePath}`);
    }

    const key = await this.resolveKey();
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    try {
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch {
      // GCM auth failure = wrong key or tampering. Never silently return empty:
      // that would look like "no credentials configured" and quietly re-prompt.
      throw new Error(
        `Could not decrypt ${this.filePath} — the encryption key does not match. ` +
          'Restore the matching key file (or CREDENTIAL_STORE_KEY), or delete the store to re-enter credentials.',
      );
    }
  }

  /** Encrypt and atomically replace the document. */
  async write(value: T): Promise<void> {
    const key = await this.resolveKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const data = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      v: 1,
      alg: ALGORITHM,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    // Write-then-rename so a crash mid-write never truncates the live store.
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(envelope), { mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
