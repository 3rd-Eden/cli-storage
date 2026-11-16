import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Storage } from '../index.js';

describe('cli-storage', /**
 * Register the package contract suite.
 * @returns {void}
 */ function storage() {
  let directory;
  let entries;

  beforeEach(/**
   * Create isolated temporary storage for the test.
   * @returns {Promise<void>} Callback result.
   */ async function prepare() {
    directory = await mkdtemp(join(tmpdir(), 'cli-storage-native-'));
    entries = [];
  });

  afterEach(/**
   * Remove temporary files and native test credentials.
   * @returns {Promise<void>} Callback result.
   */ async function cleanup() {
    for (const entry of entries) await entry.deleteCredential();
    await rm(directory, { recursive: true, force: true });
  });

  describe('native protection', /**
   * Register native credential protection coverage.
   * @returns {void}
   */ function native() {
    it('encrypts large records with a real native key and rejects damage or missing keys', /**
     * Encrypts large records with a real native key and rejects damage or missing keys.
     * @param {import('node:test').TestContext} context Test context for native-service availability reporting.
     * @returns {Promise<void>} Callback result.
     */ async function encrypted(context) {
      const store = new Storage({ namespace: `test-${randomUUID()}`, directory, backend: 'native' });
      const value = { secret: `private-${randomUUID()}`, large: 'λ'.repeat(100_000) };
      let AsyncEntry;
      try {
        ({ AsyncEntry } = await import('@napi-rs/keyring'));
        const probe = new AsyncEntry('cli-storage-test', randomUUID(), { linux: { store: 'secret-service' } });
        entries.push(probe);
        await probe.setPassword('temporary service accessibility probe');
        assert.equal(await probe.getPassword(), 'temporary service accessibility probe');
      } catch (cause) {
        context.skip(`Native credential service inaccessible: ${cause.message}`);
        return;
      }
      const initial = await store.status();
      const canonical = join(await realpath(directory), basename(initial.directory));
      const account = createHash('sha256').update(JSON.stringify([initial.namespace, canonical])).digest('hex');
      const entry = new AsyncEntry('cli-storage', account, { linux: { store: 'secret-service' } });
      entries.push(entry);
      await store.set('record', value);
      const status = await store.status('record');
      assert.equal(status.backend, 'native');
      assert.equal(status.warning, null);
      assert.equal(status.exists, true);
      const metadata = JSON.parse(await readFile(join(status.directory, 'metadata.json'), 'utf8'));
      assert.equal(metadata.account, account);
      const password = await entry.getPassword();
      assert.equal(Buffer.from(password, 'base64').length, 32);
      assert.deepEqual(await store.get('record'), value);
      assert.equal((await new Storage({ namespace: status.namespace, directory }).status()).backend, 'native');
      const names = await readdir(status.directory);
      const payload = names.find(/**
       * Select the payload rather than namespace metadata.
       * @param {string} name Directory entry name.
       * @returns {boolean} Callback result.
       */ function record(name) { return name !== 'metadata.json'; });
      const file = join(status.directory, payload);
      const text = await readFile(file, 'utf8');
      assert.equal(text.includes(value.secret), false);
      const record = JSON.parse(text);
      record.tag = Buffer.alloc(16).toString('base64');
      await writeFile(file, JSON.stringify(record));
      await assert.rejects(store.get('record'), { code: 'ESTORAGE_CORRUPT' });
      await assert.rejects(store.set('record', 'replacement'), { code: 'ESTORAGE_CORRUPT' });
      await writeFile(file, text);
      await entry.deleteCredential();
      await assert.rejects(new Storage({ namespace: status.namespace, directory }).get('record'), {
        code: 'ESTORAGE_NATIVE_KEY',
      });
      assert.equal((await store.status()).backend, 'native');
      await entry.setPassword(password);
      assert.deepEqual(await store.get('record'), value);
      assert.equal(await store.delete('record'), true);
      assert.equal(await store.get('record'), undefined);
    });
  });
});
