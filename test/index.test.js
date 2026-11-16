import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../index.js';

describe('cli-storage', /**
 * Register the package contract suite.
 * @returns {void}
 */ function storage() {
  let directory;

  beforeEach(/**
   * Create isolated temporary storage for the test.
   * @returns {Promise<void>} Callback result.
   */ async function prepare() {
    directory = await mkdtemp(join(tmpdir(), 'cli-storage-'));
  });

  afterEach(/**
   * Remove temporary files and native test credentials.
   * @returns {Promise<void>} Callback result.
   */ async function cleanup() {
    await rm(directory, { recursive: true, force: true });
  });

  describe('Storage', /**
   * Register constructor contract coverage.
   * @returns {void}
   */ function constructor() {
    it('constructs and inspects missing stores without writing', /**
     * Constructs and inspects missing stores without writing.
     * @returns {Promise<void>} Callback result.
     */ async function passive() {
      const location = join(directory, 'absent');
      const store = new Storage({ namespace: 'example', directory: location });
      const status = await store.status('record');
      assert.equal(status.backend, null);
      assert.equal(status.exists, false);
      assert.equal(status.warning, null);
      assert.equal(await store.get('record'), undefined);
      assert.deepEqual(await readdir(directory), []);
    });

    it('rejects invalid constructor options', /**
     * Rejects invalid constructor options.
     * @returns {void}
     */ function options() {
      assert.throws(/**
       * Exercise missing behavior.
       * @returns {void}
       */ function missing() { new Storage({}); }, { code: 'ESTORAGE_OPTIONS' });
      assert.throws(/**
       * Exercise backend behavior.
       * @returns {void}
       */ function backend() {
        new Storage({ namespace: 'example', backend: 'unknown' });
      }, { code: 'ESTORAGE_OPTIONS' });
    });
  });

  describe('get, set, delete and status', /**
   * Register record operation contract coverage.
   * @returns {void}
   */ function records() {
    it('round trips JSON through fresh instances and isolates namespaces and keys', /**
     * Round trips JSON through fresh instances and isolates namespaces and keys.
     * @returns {Promise<void>} Callback result.
     */ async function persist() {
      const first = new Storage({ namespace: 'one', directory, backend: 'file' });
      const second = new Storage({ namespace: 'two', directory, backend: 'file' });
      const value = { text: 'Unicode λ', nested: [false, 0, '', null], large: 'x'.repeat(100_000) };
      assert.equal(await first.get('missing'), undefined);
      assert.equal(await first.set('../record', value), undefined);
      assert.deepEqual(await new Storage({ namespace: 'one', directory }).get('../record'), value);
      assert.equal(await second.get('../record'), undefined);
      await first.set('__proto__', false);
      assert.equal(await first.get('__proto__'), false);
      assert.equal(await first.delete('../record'), true);
      assert.equal(await first.delete('../record'), false);
      assert.equal(await first.get('../record'), undefined);
      assert.equal((await first.status('../record')).exists, false);
      const status = await first.status('__proto__');
      assert.equal(status.backend, 'file');
      assert.equal(status.exists, true);
      assert.match(status.warning, /without encryption/);
      if (process.platform !== 'win32') {
        assert.equal((await stat(status.directory)).mode & 0o777, 0o700);
        for (const name of await readdir(status.directory)) {
          assert.equal((await stat(join(status.directory, name))).mode & 0o777, 0o600);
        }
      }
      for (const name of await readdir(directory)) assert.match(name, /^[a-f0-9]{64}$/);
    });

    it('keeps an established file backend when auto or native is requested', /**
     * Keeps an established file backend when auto or native is requested.
     * @returns {Promise<void>} Callback result.
     */ async function sticky() {
      const store = new Storage({ namespace: 'example', directory, backend: 'file' });
      await store.set('record', 'saved');
      assert.equal((await new Storage({ namespace: 'example', directory }).status()).backend, 'file');
      await assert.rejects(new Storage({ namespace: 'example', directory, backend: 'native' }).get('record'), {
        code: 'ESTORAGE_BACKEND',
      });
      assert.equal(await store.get('record'), 'saved');
    });

    it('rejects values that JSON would silently change', /**
     * Rejects values that json would silently change.
     * @returns {Promise<void>} Callback result.
     */ async function serialization() {
      const store = new Storage({ namespace: 'example', directory, backend: 'file' });
      const cycle = {};
      cycle.self = cycle;
      const decorated = [];
      decorated.extra = 'lost';
      /** An array class must not transform the stored JSON through inheritance. */
      class Transformed extends Array {
        /**
         * Replace this array during ordinary JSON serialization.
         * @returns {string} A value unrelated to the supplied array.
         */
        toJSON() { return 'changed'; }
      }
      for (const value of [undefined, Infinity, NaN, 1n, new Date(), { missing: undefined }, cycle, decorated, new Transformed(1, 2)]) {
        await assert.rejects(store.set('record', value), { code: 'ESTORAGE_VALUE' });
      }
      assert.deepEqual(await readdir(directory), []);
    });

    it('snapshots mutable values before waiting for filesystem work', /**
     * Snapshots mutable values before waiting for filesystem work.
     * @returns {Promise<void>} Callback result.
     */ async function snapshot() {
      const store = new Storage({ namespace: 'example', directory, backend: 'file' });
      const value = { state: 'original' };
      const pending = store.set('record', value);
      value.state = 'changed';
      await pending;
      assert.deepEqual(await store.get('record'), { state: 'original' });
    });

    it('returns structured consumer errors', /**
     * Returns structured consumer errors.
     * @returns {Promise<void>} Callback result.
     */ async function errors() {
      const store = new Storage({ namespace: 'example', directory, backend: 'file' });
      await assert.rejects(store.get(''), /**
       * Check consumer-visible error metadata.
       * @param {Error} failure Rejected storage operation error.
       * @returns {boolean} Callback result.
       */ function error(failure) {
        assert.equal(failure.code, 'ESTORAGE_KEY');
        assert.equal(failure.package, 'cli-storage');
        assert.equal(failure.method, 'get');
        assert.equal(typeof failure.reference, 'string');
        assert.match(failure.url, /^https:\/\/github.com\/3rd-Eden\/cli-storage/);
        return true;
      });
    });

    it('creates complete JSON files rather than partial writes', /**
     * Creates complete json files rather than partial writes.
     * @returns {Promise<void>} Callback result.
     */ async function atomic() {
      const store = new Storage({ namespace: 'example', directory, backend: 'file' });
      await store.set('record', { first: true });
      await store.set('record', { second: true });
      const status = await store.status();
      for (const name of await readdir(status.directory)) JSON.parse(await readFile(join(status.directory, name), 'utf8'));
      assert.deepEqual(await store.get('record'), { second: true });
    });

    it('allows reads racing the first namespace write', /**
     * Exercise fresh initialization through concurrent public readers and writers.
     * @returns {Promise<void>} All reads observe absence or a complete record.
     */ async function initialization() {
      for (let index = 0; index < 100; index++) {
        const store = new Storage({ namespace: `initial-${index}`, directory, backend: 'file' });
        await store.lock('prepare', /**
         * Create a namespace without initializing its backend.
         * @returns {void}
         */ function prepare() {});
        let written = false;
        /**
         * Mark the completed first write.
         * @returns {void}
         */ function complete() { written = true; }
        /**
         * Read while metadata and the first record are installed atomically.
         * @returns {Promise<void>} Reads satisfy the public snapshot contract.
         */ async function read() {
          do {
            const value = await store.get('record');
            assert.ok(value === undefined || value === 1);
          } while (!written);
        }
        const outcomes = await Promise.allSettled([store.set('record', 1).finally(complete), read()]);
        for (const outcome of outcomes) assert.equal(outcome.status, 'fulfilled', outcome.reason?.stack);
        assert.equal(await store.get('record'), 1);
      }
    });
  });

  describe('lock', /**
   * Register process lease contract coverage.
   * @returns {void}
   */ function locks() {
    it('binds lease methods without reacquiring and returns the callback result', /**
     * Binds lease methods without reacquiring and returns the callback result.
     * @returns {Promise<void>} Callback result.
     */ async function lease() {
      const store = new Storage({ namespace: 'example', directory, backend: 'file' });
      let escaped;
      const result = await store.lock('record', /**
       * Exercise the bound record lease.
       * @param {object} lease Bound asynchronous get, set, and delete methods.
       * @returns {Promise<string>} Callback result.
       */ async function transaction(lease) {
        escaped = lease;
        assert.equal(await lease.get(), undefined);
        await lease.set({ count: 1 });
        assert.deepEqual(await lease.get(), { count: 1 });
        assert.equal(await lease.delete(), true);
        return 'done';
      });
      assert.equal(result, 'done');
      await assert.rejects(escaped.get(), { code: 'ESTORAGE_LEASE' });
    });

    it('serializes concurrent read-modify-write work and releases on failure', /**
     * Serializes concurrent read-modify-write work and releases on failure.
     * @returns {Promise<void>} Callback result.
     */ async function contention() {
      const first = new Storage({ namespace: 'example', directory, backend: 'file' });
      const second = new Storage({ namespace: 'example', directory, backend: 'file' });
      await first.set('record', 0);
      const jobs = [];
      for (let index = 0; index < 12; index++) {
        jobs.push((index % 2 ? first : second).lock('record', /**
         * Increment the leased record without losing updates.
         * @param {object} lease Bound asynchronous get, set, and delete methods.
         * @returns {Promise<void>} Callback result.
         */ async function increment(lease) {
          const value = await lease.get();
          await lease.set(value + 1);
        }));
      }
      await Promise.all(jobs);
      assert.equal(await first.get('record'), 12);
      await assert.rejects(first.lock('record', /**
       * Exercise failure behavior.
       * @returns {Promise<void>} Callback result.
       */ async function failure() {
        throw new Error('work failed');
      }), /work failed/);
      await second.set('record', 'released');
      assert.equal(await first.get('record'), 'released');
    });

    it('aborts and times out waiters without releasing the holder', /**
     * Aborts and times out waiters without releasing the holder.
     * @returns {Promise<void>} Callback result.
     */ async function waiting() {
      const store = new Storage({ namespace: 'example', directory, backend: 'file' });
      const gate = Promise.withResolvers();
      const ready = Promise.withResolvers();
      const holding = store.lock('record', /**
       * Hold the lease until the waiting assertions complete.
       * @param {object} lease Bound asynchronous get, set, and delete methods.
       * @returns {Promise<void>} Callback result.
       */ async function holder(lease) {
        ready.resolve();
        await gate.promise;
        await lease.set('holder');
      });
      await ready.promise;
      const controller = new AbortController();
      const pending = store.lock('record', /**
       * Fail if a cancelled or contending callback runs.
       * @returns {Promise<void>} Callback result.
       */ async function forbidden() {
        assert.fail('aborted waiter acquired lock');
      }, { signal: controller.signal });
      controller.abort();
      await assert.rejects(pending, { code: 'ESTORAGE_ABORTED' });
      await assert.rejects(store.lock('record', /**
       * Fail if a cancelled or contending callback runs.
       * @returns {Promise<void>} Callback result.
       */ async function forbidden() {
        assert.fail('timed out waiter acquired lock');
      }, { timeout: 30 }), { code: 'ESTORAGE_TIMEOUT' });
      gate.resolve();
      await holding;
      assert.equal(await store.get('record'), 'holder');
    });
  });
});
