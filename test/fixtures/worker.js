import { setTimeout as pause } from 'node:timers/promises';
import { Storage } from '../../index.js';

const [action, directory, namespace, key, amount = '1'] = process.argv.slice(2);
const store = new Storage({ namespace, directory, backend: 'file' });

/**
 * Exercise public storage operations in a separate process.
 * @returns {Promise<void>}
 */
async function run() {
  if (action === 'increment') {
    for (let index = 0; index < Number(amount); index++) {
      await store.lock(key, /**
       * Increment the leased record without losing updates.
       * @param {object} lease Bound asynchronous get, set, and delete methods.
       * @returns {Promise<void>} Callback result.
       */ async function increment(lease) {
        const value = await lease.get();
        await pause(5);
        await lease.set((value ?? 0) + 1);
      });
    }
  } else if (action === 'hold') {
    await store.lock(key, /**
     * Keep the process lease alive while the parent observes it.
     * @param {object} lease Bound asynchronous get, set, and delete methods.
     * @returns {Promise<void>} Callback result.
     */ async function hold(lease) {
      process.send?.('locked');
      await pause(Number(amount));
      await lease.set('finished');
    });
  } else if (action === 'auto') {
    await new Storage({ namespace, directory }).set(key, 'automatic');
  }
  process.disconnect?.();
}

/**
 * Report child failures through its exit status and stderr.
 * @param {unknown} error Unhandled operation error.
 * @returns {void}
 */
function failed(error) {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
}

run().catch(failed);
