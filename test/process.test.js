import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Storage } from '../index.js';

const fixture = new URL('./fixtures/worker.js', import.meta.url);

/**
 * Observe child completion, including stderr in assertion failures.
 * @param {import('node:child_process').ChildProcess} child Worker process.
 * @returns {Promise<void>} Successful child completion.
 */
async function completed(child) {
  let output = '';
  /**
   * Collect child diagnostics.
   * @param {Buffer} chunk Child stderr bytes.
   * @returns {void}
   */
  function collect(chunk) { output += chunk; }
  child.stderr.on('data', collect);
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0, `Child exited with ${code ?? signal}: ${output}`);
}

describe('cli-storage', /**
 * Register the package contract suite.
 * @returns {void}
 */ function storage() {
  let directory;
  let children;

  beforeEach(/**
   * Create isolated temporary storage for the test.
   * @returns {Promise<void>} Callback result.
   */ async function prepare() {
    directory = await mkdtemp(join(tmpdir(), 'cli-storage-process-'));
    children = [];
  });

  afterEach(/**
   * Remove temporary files and native test credentials.
   * @returns {Promise<void>} Callback result.
   */ async function cleanup() {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });

  describe('process locks', /**
   * Register process lease contract coverage.
   * @returns {void}
   */ function locks() {
    it('refuses writes after heartbeat ownership is compromised', /**
     * Reject a mutation after the real lock directory disappears.
     * @returns {Promise<void>} Completed ownership assertion.
     */ async function compromised() {
      const store = new Storage({ namespace: 'process', directory, backend: 'file' });
      const ready = Promise.withResolvers();
      const gate = Promise.withResolvers();
      const holding = store.lock('counter', /**
       * Try to write only after the heartbeat observes the missing lock.
       * @param {object} lease Bound record lease.
       * @returns {Promise<void>} Rejected write after lost ownership.
       */ async function mutation(lease) {
        ready.resolve();
        await gate.promise;
        await lease.set('forbidden');
      });
      await ready.promise;
      const location = (await store.status()).directory;
      const hash = createHash('sha256').update('counter').digest('hex');
      await rm(join(location, `record-${hash}.lock`), { recursive: true });
      await pause(1300);
      gate.resolve();
      await assert.rejects(holding, { code: 'ESTORAGE_COMPROMISED' });
      assert.equal(await store.get('counter'), undefined);
      await store.set('counter', 'new owner');
      assert.equal(await store.get('counter'), 'new owner');
    });

    it('coordinates independent writers without losing updates', /**
     * Coordinates independent writers without losing updates.
     * @returns {Promise<void>} Callback result.
     */ async function writers() {
      const store = new Storage({ namespace: 'process', directory, backend: 'file' });
      await store.set('counter', 0);
      for (let index = 0; index < 4; index++) {
        children.push(fork(fixture, ['increment', directory, 'process', 'counter', '8'], { silent: true }));
      }
      await Promise.all(children.map(completed));
      assert.equal(await store.get('counter'), 32);
    });

    it('times out instead of acquiring after asynchronous setup passes the deadline', /**
     * Keep a real child-process lease past the waiter's deadline while asynchronous setup is delayed.
     * @returns {Promise<void>} Completed timeout and persisted-value assertions.
     */ async function delayedRetry() {
      const store = new Storage({ namespace: 'process', directory, backend: 'file' });
      const child = fork(fixture, ['hold', directory, 'process', 'deadline', '100'], { silent: true });
      children.push(child);
      const ended = completed(child);
      await once(child, 'message');
      const started = performance.now();
      const pending = store.lock('deadline', /**
       * Fail if the expired waiter reaches user work.
       * @returns {void} Never reached after the timeout.
       */ function forbidden() {
        assert.fail('expired waiter acquired the lock');
      }, { timeout: 40 });
      const rejected = assert.rejects(pending, { code: 'ESTORAGE_TIMEOUT' });

      while (performance.now() < started + 120) {}

      await rejected;
      await ended;
      assert.equal(await store.get('deadline'), 'finished');
    });

    it('heartbeats across the stale interval and recovers a killed holder', { timeout: 20000 }, /**
     * Heartbeats across the stale interval and recovers a killed holder.
     * @returns {Promise<void>} Callback result.
     */ async function stale() {
      const store = new Storage({ namespace: 'process', directory, backend: 'file' });
      const child = fork(fixture, ['hold', directory, 'process', 'counter', '60000'], { silent: true });
      children.push(child);
      await once(child, 'message');
      await pause(6000);
      await assert.rejects(store.lock('counter', /**
       * Fail if a cancelled or contending callback runs.
       * @returns {Promise<void>} Callback result.
       */ async function forbidden() {
        assert.fail('live holder was stolen');
      }, { timeout: 50 }), { code: 'ESTORAGE_TIMEOUT' });
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      await store.lock('counter', /**
       * Write through a lease recovered from a killed owner.
       * @param {object} lease Bound asynchronous get, set, and delete methods.
       * @returns {Promise<void>} Callback result.
       */ async function recovered(lease) {
        await lease.set('recovered');
      }, { timeout: 7000 });
      assert.equal(await store.get('counter'), 'recovered');
    });

    it('selects a persistent private file backend in a headless Linux process', { skip: process.platform !== 'linux' }, /**
     * Selects a persistent private file backend in a headless linux process.
     * @returns {Promise<void>} Callback result.
     */ async function headless() {
      const environment = { ...process.env };
      delete environment.DBUS_SESSION_BUS_ADDRESS;
      const child = fork(fixture, ['auto', directory, 'headless', 'record'], { silent: true, env: environment });
      children.push(child);
      await completed(child);
      const store = new Storage({ namespace: 'headless', directory });
      assert.equal((await store.status()).backend, 'file');
      assert.equal(await store.get('record'), 'automatic');
    });
  });
});
