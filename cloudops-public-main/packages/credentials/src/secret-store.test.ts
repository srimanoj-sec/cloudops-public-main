import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EncryptedJsonStore } from './secret-store.js';

interface Doc {
  accounts: Array<{ name: string; clientSecret: string }>;
}

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloudops-store-'));
  dirs.push(dir);
  return join(dir, 'accounts.enc.json');
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('encrypted json store', () => {
  it('round-trips a document and never writes the secret in clear text', async () => {
    const filePath = tempFile();
    const store = new EncryptedJsonStore<Doc>({ filePath });
    await store.write({ accounts: [{ name: 'Org 1', clientSecret: 'super-secret-value' }] });

    const onDisk = readFileSync(filePath, 'utf8');
    expect(onDisk).not.toContain('super-secret-value');
    expect(onDisk).not.toContain('Org 1');

    const reloaded = await new EncryptedJsonStore<Doc>({ filePath }).read();
    expect(reloaded?.accounts[0]?.clientSecret).toBe('super-secret-value');
  });

  it('returns null when nothing has been stored yet', async () => {
    expect(await new EncryptedJsonStore<Doc>({ filePath: tempFile() }).read()).toBeNull();
  });

  it('fails loudly on a key mismatch instead of reporting an empty store', async () => {
    const filePath = tempFile();
    await new EncryptedJsonStore<Doc>({ filePath }).write({ accounts: [] });

    const wrongKey = new EncryptedJsonStore<Doc>({
      filePath,
      key: Buffer.alloc(32, 7).toString('base64'),
    });
    await expect(wrongKey.read()).rejects.toThrow(/does not match/);
  });

  it('uses a configured key without generating a key file', async () => {
    const filePath = tempFile();
    const key = Buffer.alloc(32, 3).toString('hex');
    const store = new EncryptedJsonStore<Doc>({ filePath, key });
    expect(store.keyIsExternal).toBe(true);

    await store.write({ accounts: [{ name: 'Org', clientSecret: 's' }] });
    expect(() => readFileSync(`${filePath}.key`, 'utf8')).toThrow();
    expect((await new EncryptedJsonStore<Doc>({ filePath, key }).read())?.accounts).toHaveLength(1);
  });
});
