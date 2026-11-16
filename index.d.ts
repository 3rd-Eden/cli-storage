/** Finite, acyclic JSON data; additional runtime validation is documented in the README. */
export type StorageValue = null | boolean | number | string | readonly StorageValue[] | {
  readonly [key: string]: StorageValue;
};

/** Runtime configuration for an isolated storage namespace. */
export interface StorageOptions {
  /** Stable, nonempty application namespace. */
  readonly namespace: string;
  /** Private storage root; defaults to the platform data directory. */
  readonly directory?: string;
  /** Initial preference; persisted backend selection remains sticky. Defaults to auto. */
  readonly backend?: 'auto' | 'native' | 'file';
}

/** Controls acquisition only; a running callback retains its lease until completion. */
export interface StorageLockOptions {
  /** Abort lock acquisition before its callback starts. */
  readonly signal?: AbortSignal;
  /** Finite, nonnegative acquisition timeout in milliseconds; absent waits indefinitely. */
  readonly timeout?: number;
}

/** Passive inspection of persisted backend details and optional record presence. */
export interface StorageStatus {
  /** Configured application namespace. */
  readonly namespace: string;
  /** Absolute hashed namespace directory, whether or not initialized. */
  readonly directory: string;
  /** Persisted backend, explicit fresh preference, or null for an uninitialized auto store. */
  readonly backend: 'native' | 'file' | null;
  /** Plaintext protection warning for file storage; otherwise null. */
  readonly warning: string | null;
  /** Record presence when status was called with a key; otherwise omitted. */
  readonly exists?: boolean;
}

/** Frozen methods bound to the key and ownership of one active callback. */
export interface StorageLease {
  /**
   * Read the bound record without reacquiring its lock.
   * @returns Stored JSON data or undefined when absent.
   * @throws Storage access, corruption, native, or expired/compromised lease failures.
   */
  get(): Promise<StorageValue | undefined>;
  /**
   * Atomically replace the bound record without reacquiring its lock.
   * @param value Finite, acyclic JSON data, snapshotted before asynchronous work.
   * @returns Completion after atomic replacement.
   * @throws Validation, access, corruption, native, or expired/compromised lease failures.
   */
  set(value: StorageValue): Promise<void>;
  /**
   * Remove the bound record without reacquiring its lock.
   * @returns True when removed, false when absent.
   * @throws Access, corruption, native, or expired/compromised lease failures.
   */
  delete(): Promise<boolean>;
}

/** Private JSON records with persistent native key protection and process-safe leases. */
export class Storage {
  /**
   * Construct an instance without filesystem or keyring I/O.
   * @param options Namespace, optional storage root, and initial backend preference.
   * @throws ESTORAGE_OPTIONS for invalid options.
   */
  constructor(options: StorageOptions);
  /**
   * Read an atomic record snapshot without creating files or acquiring a write lock.
   * @param key Nonempty record identity.
   * @returns Stored JSON data or undefined when absent.
   * @throws Key, access, corruption, backend, or native failures.
   */
  get(key: string): Promise<StorageValue | undefined>;
  /**
   * Atomically replace one record under its process lock.
   * @param key Nonempty record identity.
   * @param value Finite, acyclic JSON data, snapshotted before asynchronous work.
   * @returns Completion after replacement.
   * @throws Validation, locking, access, corruption, backend, or native failures.
   */
  set(key: string, value: StorageValue): Promise<void>;
  /**
   * Remove one record under its process lock.
   * @param key Nonempty record identity.
   * @returns True when removed, false when absent.
   * @throws Key, locking, access, corruption, backend, or native failures.
   */
  delete(key: string): Promise<boolean>;
  /**
   * Run work under a renewable process lock using bound, non-reacquiring methods.
   * @param key Nonempty record identity.
   * @param work Callback receiving the key's active lease.
   * @param options Optional acquisition signal and wait timeout.
   * @returns Awaited callback result after initiated operations drain and ownership releases.
   * @throws Validation, acquisition, compromise, record/native, or callback failures.
   */
  lock<T>(key: string, work: (lease: StorageLease) => T, options?: StorageLockOptions): Promise<Awaited<T>>;
  /**
   * Inspect persisted backend and optional record presence without keyring probing or writes.
   * @param key Optional nonempty record identity.
   * @returns Passive namespace status and optional presence indicator.
   * @throws Key, access, corruption, or backend failures.
   */
  status(key?: string): Promise<StorageStatus>;
}
