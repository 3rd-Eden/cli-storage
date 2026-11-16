import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../index.js';

/**
 * Locate a public key's documented on-disk record.
 * @param {string} directory Namespace directory.
 * @param {string} key Record key.
 * @returns {string} Record file.
 */
function filename(directory, key) {
  return join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
}

describe('cli-storage', /**
 * Register the package contract suite.
 * @returns {void}
 */ function storage() {
  let directory;
  let store;
  let location;

  beforeEach(/**
   * Create isolated temporary storage for the test.
   * @returns {Promise<void>} Callback result.
   */ async function prepare() {
    directory = await mkdtemp(join(tmpdir(), 'cli-storage-integrity-'));
    store = new Storage({ namespace: 'integrity', directory, backend: 'file' });
    await store.set('record', { secret: 'preserved' });
    location = (await store.status()).directory;
  });

  afterEach(/**
   * Remove temporary files and native test credentials.
   * @returns {Promise<void>} Callback result.
   */ async function cleanup() {
    await rm(directory, { recursive: true, force: true });
  });

  describe('corruption', /**
   * Register damaged storage contract coverage.
   * @returns {void}
   */ function corruption() {
    it('fails reads, writes and deletes without replacing damaged data', /**
     * Fails reads, writes and deletes without replacing damaged data.
     * @returns {Promise<void>} Callback result.
     */ async function invalid() {
      const file = filename(location, 'record');
      await writeFile(file, '{broken', { mode: 0o600 });
      await assert.rejects(store.get('record'), { code: 'ESTORAGE_CORRUPT' });
      await assert.rejects(store.set('record', 'replacement'), { code: 'ESTORAGE_CORRUPT' });
      await assert.rejects(store.delete('record'), { code: 'ESTORAGE_CORRUPT' });
      await assert.rejects(store.status('record'), { code: 'ESTORAGE_CORRUPT' });
      assert.equal(await readFile(file, 'utf8'), '{broken');
    });

    it('refuses missing metadata rather than treating existing records as empty', /**
     * Refuses missing metadata rather than treating existing records as empty.
     * @returns {Promise<void>} Callback result.
     */ async function missing() {
      await rm(join(location, 'metadata.json'));
      await assert.rejects(store.get('record'), { code: 'ESTORAGE_CORRUPT' });
      await assert.rejects(store.set('record', 'replacement'), { code: 'ESTORAGE_CORRUPT' });
      await assert.rejects(store.status(), { code: 'ESTORAGE_CORRUPT' });
    });

    it('refuses unknown formats and record identity mismatches', /**
     * Refuses unknown formats and record identity mismatches.
     * @returns {Promise<void>} Callback result.
     */ async function version() {
      const file = filename(location, 'record');
      const record = JSON.parse(await readFile(file, 'utf8'));
      record.version = 99;
      await writeFile(file, JSON.stringify(record));
      await assert.rejects(store.get('record'), { code: 'ESTORAGE_CORRUPT' });
      record.version = 1;
      record.identity = 'wrong';
      await writeFile(file, JSON.stringify(record));
      await assert.rejects(store.get('record'), { code: 'ESTORAGE_CORRUPT' });
    });

    it('rejects parsed numbers outside JSON storage numeric bounds', /**
     * Rejects parsed numbers outside json storage numeric bounds.
     * @returns {Promise<void>} Callback result.
     */ async function numbers() {
      const file = filename(location, 'record');
      const text = await readFile(file, 'utf8');
      await writeFile(file, text.replace('{"secret":"preserved"}', '1e999'));
      await assert.rejects(store.get('record'), { code: 'ESTORAGE_CORRUPT' });
    });
  });

  describe('private filesystem access', /**
   * Register filesystem privacy contract coverage.
   * @returns {void}
   */ function permissions() {
    it('rejects unsafe root, directory and record permissions', { skip: process.platform === 'win32' }, /**
     * Rejects unsafe root, directory and record permissions.
     * @returns {Promise<void>} Callback result.
     */ async function modes() {
      await chmod(directory, 0o755);
      await assert.rejects(store.get('record'), { code: 'ESTORAGE_ACCESS' });
      await chmod(directory, 0o700);
      await chmod(location, 0o755);
      await assert.rejects(store.get('record'), { code: 'ESTORAGE_ACCESS' });
      await chmod(location, 0o700);
      await chmod(filename(location, 'record'), 0o644);
      await assert.rejects(store.get('record'), { code: 'ESTORAGE_ACCESS' });
      await assert.rejects(store.set('record', 'replacement'), { code: 'ESTORAGE_ACCESS' });
    });

    it('rejects symlink record files without following or replacing them', { skip: process.platform === 'win32' }, /**
     * Rejects symlink record files without following or replacing them.
     * @returns {Promise<void>} Callback result.
     */ async function links() {
      const outside = join(directory, 'outside.json');
      await writeFile(outside, 'untouched', { mode: 0o600 });
      await rm(filename(location, 'record'));
      await symlink(outside, filename(location, 'record'));
      await assert.rejects(store.get('record'), { code: 'ESTORAGE_ACCESS' });
      await assert.rejects(store.set('record', 'replacement'), { code: 'ESTORAGE_ACCESS' });
      assert.equal(await readFile(outside, 'utf8'), 'untouched');
    });
  });
});
