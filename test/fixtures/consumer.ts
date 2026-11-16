import {
  Storage,
  type StorageLease,
  type StorageLockOptions,
  type StorageOptions,
  type StorageStatus,
  type StorageValue,
} from 'cli-storage';

const options: StorageOptions = { namespace: 'typed-consumer', directory: 'records', backend: 'file' };
const store = new Storage(options);
const control: StorageLockOptions = { timeout: 1000, signal: new AbortController().signal };
const value: StorageValue = { values: [null, false, 1, 'text'] };

/**
 * Exercise a typed consumer against the installed package's public contract.
 * @returns {Promise<void>} Successful public API assertions.
 */
async function run(): Promise<void> {
  await store.set('value', value);
  const current: StorageValue | undefined = await store.get('value');
  if (JSON.stringify(current) !== JSON.stringify(value)) throw new Error('Typed record did not round trip.');
  /**
   * Increment a bound record while preserving its typed callback result.
   * @param lease Active record lease.
   * @returns Updated counter value.
   */
  async function update(lease: StorageLease): Promise<number> {
    const previous = await lease.get();
    const next = typeof previous === 'number' ? previous + 1 : 1;
    await lease.set(next);
    return next;
  }
  const result: number = await store.lock('counter', update, control);
  if (result !== 1) throw new Error('Lock callback result type or runtime result was lost.');
  const status: StorageStatus = await store.status('counter');
  if (status.backend !== 'file' || !status.exists) throw new Error('Typed status was incorrect.');
  const removed: boolean = await store.delete('value');
  if (!removed) throw new Error('Typed delete did not return true.');
  console.log('typed consumer passed');
}

/**
 * Check invalid inputs without executing them at runtime.
 * @param {StorageLease} lease Bound lease whose methods accept no key.
 * @returns {void}
 */
function invalid(lease: StorageLease): void {
  // @ts-expect-error Backend values are a fixed union.
  new Storage({ namespace: 'typed-consumer', backend: 'other' });
  // @ts-expect-error Record keys must be strings.
  store.get(123);
  // @ts-expect-error Functions cannot be stored as JSON data.
  store.set('invalid', invalid);
  // @ts-expect-error A lease is already bound to its key.
  lease.get('another-key');
  /**
   * Return a numeric callback result for a rejected string assignment.
   * @returns Constant numeric value.
   */
  async function numeric(): Promise<number> { return 1; }
  // @ts-expect-error Lock callback results preserve their type.
  const result: Promise<string> = store.lock('counter', numeric);
  void result;
}

await run();
