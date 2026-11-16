import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import paths from 'env-paths';
import locking from 'proper-lockfile';
import atomic from 'write-file-atomic';

/**
 * @typedef {null | boolean | number | string | Array<JSONValue> | { [key: string]: JSONValue }} JSONValue
 */

/**
 * @typedef {object} Lease
 * @property {function(): Promise<JSONValue | undefined>} get Read the locked record.
 * @property {function(JSONValue): Promise<void>} set Replace the locked record.
 * @property {function(): Promise<boolean>} delete Remove the locked record.
 */

/**
 * @typedef {object} Status
 * @property {string} namespace Logical namespace.
 * @property {string} directory Absolute namespace directory.
 * @property {'native' | 'file' | null} backend Persisted backend or uninitialized preference.
 * @property {string | null} warning File backend protection notice, otherwise null.
 * @property {boolean} [exists] Whether the requested record exists; omitted without a key.
 */

/** Consumer-visible failure with a stable reference and documentation link. */
class StorageError extends Error {
  /**
   * @param {string} code Stable machine-readable error code.
   * @param {string} method Source operation.
   * @param {string} message Explanation without record contents.
   * @param {unknown} [cause] Underlying failure.
   */
  constructor(code, method, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
    this.code = code;
    this.package = 'cli-storage';
    this.method = method;
    this.reference = code.toLowerCase().replaceAll('_', '-');
    this.url = `https://github.com/3rd-Eden/cli-storage#${this.reference}`;
  }
}

/**
 * Hash an identity without exposing arbitrary strings as paths.
 * @param {string} value Identity text.
 * @returns {string} SHA-256 hex digest.
 */
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Validate a namespace or record key.
 * @param {unknown} value Candidate identity.
 * @param {string} method Source operation.
 * @param {string} code Failure code.
 * @returns {void}
 */
function identity(value, method, code = 'ESTORAGE_KEY') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StorageError(code, method, 'Expected a nonempty string.');
  }
  if (!value.isWellFormed()) {
    throw new StorageError(code, method, 'Expected a string containing well-formed Unicode.');
  }
}

/**
 * Reject JSON values that would be dropped or changed during serialization.
 * @param {unknown} value Candidate value.
 * @param {string} method Source operation.
 * @param {Set<object>} [seen] Current ancestor objects.
 * @returns {void}
 */
function serializable(value, method, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) {
    throw new StorageError('ESTORAGE_VALUE', method, 'Values must be finite, acyclic JSON data.');
  }
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0) {
    throw new StorageError('ESTORAGE_VALUE', method, 'Values must use plain JSON objects and arrays.');
  }
  const properties = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(properties);
  if (array && Object.keys(value).length !== value.length) {
    throw new StorageError('ESTORAGE_VALUE', method, 'Arrays must be dense and cannot contain extra properties.');
  }
  seen.add(value);
  for (const [name, property] of entries) {
    if (array && name === 'length') continue;
    if (!property.enumerable || !Object.hasOwn(property, 'value') ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length))) {
      throw new StorageError('ESTORAGE_VALUE', method, 'JSON properties must be enumerable data properties.');
    }
    serializable(property.value, method, seen);
  }
  seen.delete(value);
}

/**
 * Capture JSON data before an asynchronous operation yields to its caller.
 * @param {JSONValue} value Candidate record.
 * @param {string} method Source operation.
 * @returns {JSONValue} Independent JSON snapshot.
 */
function snapshot(value, method) {
  serializable(value, method);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Read and validate a filesystem entry without following its final symlink.
 * @param {string} file Entry path.
 * @param {boolean} directory Whether a directory is required.
 * @param {string} method Source operation.
 * @returns {Promise<import('node:fs').Stats | undefined>} Entry metadata or absence.
 */
async function inspect(file, directory, method) {
  let info;
  try {
    info = await lstat(file);
  } catch (cause) {
    if (cause.code === 'ENOENT') return undefined;
    throw new StorageError('ESTORAGE_ACCESS', method, 'Could not inspect private storage.', cause);
  }
  if ((directory ? !info.isDirectory() : !info.isFile()) ||
      (process.platform !== 'win32' && ((info.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())))) {
    throw new StorageError('ESTORAGE_ACCESS', method, 'Storage requires owned directories (0700) and regular files (0600).');
  }
  return info;
}

/**
 * Read a private JSON file with explicit absence and corruption semantics.
 * @param {string} file File path.
 * @param {string} method Source operation.
 * @returns {Promise<object | undefined>} Parsed document or absence.
 */
async function document(file, method) {
  if (!await inspect(file, false, method)) return undefined;
  let handle;
  let text;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || (process.platform !== 'win32' &&
        ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()))) {
      throw new StorageError('ESTORAGE_ACCESS', method, 'Storage file ownership or permissions changed.');
    }
    text = await handle.readFile('utf8');
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    if (cause.code === 'ENOENT') return undefined;
    throw new StorageError('ESTORAGE_ACCESS', method, 'Could not read private storage.', cause);
  } finally {
    await handle?.close();
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new StorageError('ESTORAGE_CORRUPT', method, 'Storage document is not an object.');
    }
    return value;
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    throw new StorageError('ESTORAGE_CORRUPT', method, 'Storage contains invalid JSON.', cause);
  }
}

/**
 * Atomically replace one private JSON file.
 * @param {string} file Destination path.
 * @param {object} value Document to serialize.
 * @param {string} method Source operation.
 * @returns {Promise<void>}
 */
async function write(file, value, method) {
  await inspect(file, false, method);
  try {
    await atomic(file, JSON.stringify(value), { mode: 0o600, chown: false, fsync: true });
  } catch (cause) {
    throw new StorageError('ESTORAGE_ACCESS', method, 'Could not atomically write private storage.', cause);
  }
}

/**
 * Decode a canonical base64 field and validate its size.
 * @param {unknown} value Encoded field.
 * @param {number | undefined} length Required decoded length, if fixed.
 * @param {string} method Source operation.
 * @returns {Buffer} Decoded bytes.
 */
function decode(value, length, method) {
  if (typeof value !== 'string') throw new StorageError('ESTORAGE_CORRUPT', method, 'Invalid encrypted storage field.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) {
    throw new StorageError('ESTORAGE_CORRUPT', method, 'Invalid encrypted storage encoding.');
  }
  return bytes;
}

/**
 * Determine whether a fresh native backend is unavailable rather than denied.
 * @param {unknown} cause Native failure.
 * @returns {boolean} Whether a fresh auto store may use private files.
 */
function unavailable(cause) {
  return cause?.code === 'ERR_MODULE_NOT_FOUND' || cause?.code === 'MODULE_NOT_FOUND' ||
    /failed to load native binding|unsupported (platform|architecture)|secret service.*(unavailable|not available)|no secret service|org\.freedesktop\.DBus\.Error\.(ServiceUnknown|NoServer)|failed to connect to.*(bus|socket)|no such file or directory.*(bus|socket)/i.test(cause?.message ?? '');
}

/** Private JSON records with backend persistence and renewable process locks. */
export class Storage {
  #namespace;
  #root;
  #directory;
  #backend;

  /**
   * @param {object} options Storage configuration.
   * @param {string} options.namespace Stable application namespace.
   * @param {string} [options.directory] Private storage root; defaults to env-paths data.
   * @param {'auto' | 'native' | 'file'} [options.backend='auto'] Initial backend preference.
   * @throws {Error} ESTORAGE_OPTIONS for invalid options. Performs no I/O.
   */
  constructor(options) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new StorageError('ESTORAGE_OPTIONS', 'constructor', 'Storage options must be an object.');
    }
    identity(options.namespace, 'constructor', 'ESTORAGE_OPTIONS');
    const backend = options.backend ?? 'auto';
    if (!['auto', 'native', 'file'].includes(backend)) {
      throw new StorageError('ESTORAGE_OPTIONS', 'constructor', 'Backend must be auto, native, or file.');
    }
    if (options.directory !== undefined) identity(options.directory, 'constructor', 'ESTORAGE_OPTIONS');
    this.#namespace = options.namespace;
    this.#root = resolve(options.directory ?? paths('cli-storage', { suffix: '' }).data);
    this.#directory = join(this.#root, digest(this.#namespace));
    this.#backend = backend;
  }

  /**
   * Read a complete record without creating files or acquiring a write lock.
   * @param {string} key Record key.
   * @returns {Promise<JSONValue | undefined>} Stored value or undefined when absent.
   * @throws {Error} Storage access, corruption, backend, or native protection failures.
   */
  async get(key) {
    identity(key, 'get');
    return this.#read(key, 'get');
  }

  /**
   * Replace one JSON record under its process lock.
   * @param {string} key Record key.
   * @param {JSONValue} value Finite, acyclic JSON data.
   * @returns {Promise<void>}
   * @throws {Error} Invalid data, locking, storage access, corruption, or native failures.
   */
  async set(key, value) {
    identity(key, 'set');
    const record = snapshot(value, 'set');
    /**
     * Write the captured record through the acquired lease.
     * @param {Lease} lease Bound record lease.
     * @returns {Promise<void>}
     */
    async function save(lease) {
      await lease.set(record);
    }
    await this.lock(key, save);
  }

  /**
   * Remove one record under its process lock.
   * @param {string} key Record key.
   * @returns {Promise<boolean>} True if a record was removed, false if absent.
   * @throws {Error} Locking, storage access, corruption, or native failures.
   */
  async delete(key) {
    identity(key, 'delete');
    /**
     * Delete through the acquired lease.
     * @param {Lease} lease Bound record lease.
     * @returns {Promise<boolean>} Whether a record was removed.
     */
    async function remove(lease) {
      return lease.delete();
    }
    return this.lock(key, remove);
  }

  /**
   * Inspect persisted backend and optional record presence without probing keyrings or writing.
   * @param {string} [key] Optional record key.
   * @returns {Promise<Status>} Backend details and optional presence indicator.
   * @throws {Error} Invalid key, incompatible backend, filesystem access, or format failures.
   */
  async status(key) {
    if (key !== undefined) identity(key, 'status');
    const metadata = await this.#metadata('status');
    const backend = metadata?.backend ?? (this.#backend === 'auto' ? null : this.#backend);
    const result = {
      namespace: this.#namespace,
      directory: this.#directory,
      backend,
      warning: backend === 'file' ? (process.platform === 'win32'
        ? 'Records are stored without encryption using inherited Windows directory ACLs; directory access permits reading them.'
        : 'Records are stored without encryption in private files; filesystem access permits reading them.') : null,
    };
    if (key !== undefined) result.exists = Boolean(metadata && await this.#record(key, metadata, 'status'));
    return result;
  }

  /**
   * Run work while a renewable, cross-process lock protects one record.
   * @template T
   * @param {string} key Record key.
   * @param {function(Lease): T | Promise<T>} work Named callback using the bound lease.
   * @param {object} [options] Acquisition controls; never interrupt a running callback.
   * @param {AbortSignal} [options.signal] Cancel acquisition while waiting.
   * @param {number} [options.timeout] Maximum acquisition wait in milliseconds; absent waits indefinitely.
   * @returns {Promise<T>} Callback result after lease operations finish and the lock releases.
   * @throws {Error} Invalid input, cancelled/timed out acquisition, compromised lock, or callback failure.
   */
  async lock(key, work, options = {}) {
    identity(key, 'lock');
    if (typeof work !== 'function' || options === null || typeof options !== 'object' ||
        (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) ||
        (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
      throw new StorageError('ESTORAGE_OPTIONS', 'lock', 'Expected a callback, optional AbortSignal, and nonnegative finite timeout.');
    }
    const state = { compromised: undefined };
    const release = await this.#acquire(`record-${digest(key)}`, options, state);
    const pending = new Set();
    const store = this;
    let active = true;
    /**
     * Validate that work still owns its renewable lease.
     * @returns {void}
     */
    function check() {
      if (!active) throw new StorageError('ESTORAGE_LEASE', 'lock', 'The lease callback has completed.');
      if (state.compromised) throw new StorageError('ESTORAGE_COMPROMISED', 'lock', 'Lock ownership was lost.', state.compromised);
    }
    /**
     * Keep initiated operations inside the lease lifetime.
     * @param {Promise<unknown>} operation Started record operation.
     * @returns {Promise<unknown>} Original operation.
     */
    function track(operation) {
      pending.add(operation);
      /**
       * Stop tracking a completed lease operation.
       * @returns {void}
       */
      function settled() { pending.delete(operation); }
      operation.then(settled, settled);
      return operation;
    }
    const lease = Object.freeze({
      /**
       * Read the bound record under existing ownership.
       * @returns {Promise<JSONValue | undefined>} Current record.
       */
      async get() {
        check();
        return track(store.#read(key, 'get'));
      },
      /**
       * Replace the bound record under existing ownership.
       * @param {JSONValue} value Replacement record.
       * @returns {Promise<void>}
       */
      async set(value) {
        check();
        const record = snapshot(value, 'set');
        return track(store.#save(key, record, check));
      },
      /**
       * Remove the bound record under existing ownership.
       * @returns {Promise<boolean>} Whether a record was removed.
       */
      async delete() {
        check();
        return track(store.#remove(key, check));
      },
    });
    try {
      const result = await work(lease);
      await Promise.allSettled(pending);
      check();
      return result;
    } finally {
      active = false;
      await Promise.allSettled(pending);
      if (!state.compromised) {
        try {
          await release();
        } catch (cause) {
          throw new StorageError('ESTORAGE_COMPROMISED', 'lock', 'Could not release the record lock.', cause);
        }
      }
    }
  }

  /**
   * Validate or lazily create the private directory hierarchy.
   * @param {string} method Source operation.
   * @param {boolean} [create=false] Whether absence should be initialized.
   * @returns {Promise<boolean>} Whether the namespace directory exists.
   */
  async #directories(method, create = false) {
    if (create) {
      try {
        await mkdir(this.#root, { recursive: true, mode: 0o700 });
      } catch (cause) {
        throw new StorageError('ESTORAGE_ACCESS', method, 'Could not create private storage root.', cause);
      }
    }
    if (!await inspect(this.#root, true, method)) return false;
    if (create) {
      try {
        await mkdir(this.#directory, { mode: 0o700 });
      } catch (cause) {
        if (cause.code !== 'EEXIST') throw new StorageError('ESTORAGE_ACCESS', method, 'Could not create private namespace.', cause);
      }
    }
    return Boolean(await inspect(this.#directory, true, method));
  }

  /**
   * Read and validate backend metadata, refusing orphan data or backend changes.
   * @param {string} method Source operation.
   * @returns {Promise<object | undefined>} Persisted backend metadata or absence.
   */
  async #metadata(method) {
    if (!await this.#directories(method)) return undefined;
    let value = await document(join(this.#directory, 'metadata.json'), method);
    if (value === undefined) {
      let names;
      try {
        names = await readdir(this.#directory);
      } catch (cause) {
        throw new StorageError('ESTORAGE_ACCESS', method, 'Could not inspect storage metadata.', cause);
      }
      // A first writer may install metadata between the absent lookup and directory listing.
      value = await document(join(this.#directory, 'metadata.json'), method);
      if (value === undefined) {
        /**
         * Detect payload files that cannot be interpreted without metadata.
         * @param {string} name Directory entry name.
         * @returns {boolean} Whether the entry is a JSON record.
         */
        function payload(name) { return name !== 'metadata.json' && name.endsWith('.json'); }
        if (names.some(payload)) {
          throw new StorageError('ESTORAGE_CORRUPT', method, 'Records exist without backend metadata. Restore the metadata before proceeding.');
        }
        return undefined;
      }
    }
    if (value.version !== 1 || value.namespace !== this.#namespace || !['native', 'file'].includes(value.backend) ||
        (value.backend === 'native' && !/^[a-f0-9]{64}$/.test(value.account ?? ''))) {
      throw new StorageError('ESTORAGE_CORRUPT', method, 'Invalid storage metadata or unsupported format version.');
    }
    if (this.#backend !== 'auto' && value.backend !== this.#backend) {
      throw new StorageError('ESTORAGE_BACKEND', method, 'The persisted backend differs from the requested backend. Use auto or the existing backend.');
    }
    return value;
  }

  /**
   * Read a record envelope and validate its identity and backend.
   * @param {string} key Record key.
   * @param {object} metadata Persisted namespace metadata.
   * @param {string} method Source operation.
   * @returns {Promise<object | undefined>} Valid record envelope or absence.
   */
  async #record(key, metadata, method) {
    const name = digest(key);
    const value = await document(join(this.#directory, `${name}.json`), method);
    if (value === undefined) return undefined;
    if (value.version !== 1 || value.identity !== name || value.backend !== metadata.backend ||
        (value.backend === 'file' && !Object.hasOwn(value, 'value'))) {
      throw new StorageError('ESTORAGE_CORRUPT', method, 'Invalid record envelope, identity, or backend.');
    }
    if (value.backend === 'native') {
      decode(value.iv, 12, method);
      decode(value.tag, 16, method);
      decode(value.data, undefined, method);
    } else {
      try {
        serializable(value.value, method);
      } catch (cause) {
        throw new StorageError('ESTORAGE_CORRUPT', method, 'Stored JSON data is outside the supported value contract.', cause);
      }
    }
    return value;
  }

  /**
   * Read and decrypt a record if present.
   * @param {string} key Record key.
   * @param {string} method Source operation.
   * @returns {Promise<JSONValue | undefined>} Stored value or absence.
   */
  async #read(key, method) {
    const metadata = await this.#metadata(method);
    if (!metadata) return undefined;
    const record = await this.#record(key, metadata, method);
    if (!record) return undefined;
    if (metadata.backend === 'file') return record.value;
    const secret = await this.#secret(metadata, false, method);
    try {
      const cipher = createDecipheriv('aes-256-gcm', secret, decode(record.iv, 12, method));
      cipher.setAAD(Buffer.from(JSON.stringify([this.#namespace, key])));
      cipher.setAuthTag(decode(record.tag, 16, method));
      const text = Buffer.concat([cipher.update(decode(record.data, undefined, method)), cipher.final()]);
      const value = JSON.parse(text.toString('utf8'));
      serializable(value, method);
      return value;
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError('ESTORAGE_CORRUPT', method, 'Encrypted record authentication or JSON decoding failed.', cause);
    } finally {
      secret.fill(0);
    }
  }

  /**
   * Initialize a sticky backend under a separate namespace lock.
   * @returns {Promise<object>} Persisted namespace metadata.
   */
  async #initialize() {
    const state = { compromised: undefined };
    const release = await this.#acquire('backend', {}, state);
    try {
      const existing = await this.#metadata('set');
      if (existing) return existing;
      const account = digest(JSON.stringify([this.#namespace, await realpath(this.#directory)]));
      let backend = this.#backend === 'file' ? 'file' : 'native';
      if (this.#backend === 'auto' &&
          (!['darwin', 'win32', 'linux'].includes(process.platform) ||
          (process.platform === 'linux' && !process.env.DBUS_SESSION_BUS_ADDRESS))) backend = 'file';
      const metadata = { version: 1, namespace: this.#namespace, backend };
      if (backend === 'native') {
        metadata.account = account;
        try {
          const secret = await this.#secret(metadata, true, 'set');
          secret.fill(0);
        } catch (cause) {
          if (this.#backend !== 'auto' || cause.code !== 'ESTORAGE_NATIVE_UNAVAILABLE') throw cause;
          metadata.backend = 'file';
          delete metadata.account;
        }
      }
      if (state.compromised) throw new StorageError('ESTORAGE_COMPROMISED', 'set', 'Backend lock ownership was lost.', state.compromised);
      await write(join(this.#directory, 'metadata.json'), metadata, 'set');
      return metadata;
    } finally {
      if (!state.compromised) await release();
    }
  }

  /**
   * Load or initialize the namespace encryption key in persistent native storage.
   * @param {object} metadata Native namespace metadata with account identity.
   * @param {boolean} create Whether a missing key may be created for a fresh namespace.
   * @param {string} method Source operation.
   * @returns {Promise<Buffer>} 32-byte encryption key; caller clears it after use.
   */
  async #secret(metadata, create, method) {
    let password;
    try {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      const entry = new AsyncEntry('cli-storage', metadata.account, { linux: { store: 'secret-service' } });
      password = await entry.getPassword();
      if (password === null && create) {
        password = randomBytes(32).toString('base64');
        await entry.setPassword(password);
        if (await entry.getPassword() !== password) {
          throw new StorageError('ESTORAGE_NATIVE_ACCESS', method, 'Native storage did not preserve the encryption key.');
        }
      }
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError(unavailable(cause) ? 'ESTORAGE_NATIVE_UNAVAILABLE' : 'ESTORAGE_NATIVE_ACCESS', method,
        'Could not access persistent native key protection. Unlock the operating system credential service.', cause);
    }
    if (password === null) {
      throw new StorageError('ESTORAGE_NATIVE_KEY', method, 'The persisted native encryption key is missing. Restore its keychain entry.');
    }
    const secret = decode(password, 32, method);
    return secret;
  }

  /**
   * Validate the old record and atomically replace it inside an active lease.
   * @param {string} key Record key.
   * @param {JSONValue} value Replacement data.
   * @param {function(): void} check Lease ownership check.
   * @returns {Promise<void>}
   */
  async #save(key, value, check) {
    await this.#read(key, 'set');
    const metadata = await this.#metadata('set') ?? await this.#initialize();
    const record = { version: 1, identity: digest(key), backend: metadata.backend };
    if (metadata.backend === 'file') record.value = value;
    else {
      const secret = await this.#secret(metadata, false, 'set');
      try {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', secret, iv);
        cipher.setAAD(Buffer.from(JSON.stringify([this.#namespace, key])));
        record.iv = iv.toString('base64');
        record.data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]).toString('base64');
        record.tag = cipher.getAuthTag().toString('base64');
      } finally {
        secret.fill(0);
      }
    }
    check();
    await write(join(this.#directory, `${record.identity}.json`), record, 'set');
  }

  /**
   * Validate and unlink a record inside an active lease.
   * @param {string} key Record key.
   * @param {function(): void} check Lease ownership check.
   * @returns {Promise<boolean>} Whether the record existed.
   */
  async #remove(key, check) {
    if (await this.#read(key, 'delete') === undefined) return false;
    check();
    try {
      await unlink(join(this.#directory, `${digest(key)}.json`));
      return true;
    } catch (cause) {
      if (cause.code === 'ENOENT') return false;
      throw new StorageError('ESTORAGE_ACCESS', 'delete', 'Could not delete the private record.', cause);
    }
  }

  /**
   * Acquire a proper-lockfile lease with cancellable acquisition and heartbeat updates.
   * @param {string} name Hashed record lock or reserved backend lock name.
   * @param {object} options Acquisition options.
   * @param {AbortSignal} [options.signal] Acquisition cancellation.
   * @param {number} [options.timeout] Acquisition wait limit in milliseconds.
   * @param {{ compromised: Error | undefined }} state Mutable compromise signal.
   * @returns {Promise<function(): Promise<void>>} Native lock release function.
   */
  async #acquire(name, options, state) {
    if (options.signal?.aborted) throw new StorageError('ESTORAGE_ABORTED', 'lock', 'Lock acquisition was aborted.', options.signal.reason);
    const deadline = options.timeout === undefined ? Infinity : performance.now() + options.timeout;
    await this.#directories('lock', true);
    /**
     * Record lost ownership without throwing from a timer callback.
     * @param {Error} cause Lock heartbeat failure.
     * @returns {void}
     */
    function compromised(cause) { state.compromised = cause; }
    let first = true;
    let failure;
    while (true) {
      if (options.signal?.aborted) throw new StorageError('ESTORAGE_ABORTED', 'lock', 'Lock acquisition was aborted.', options.signal.reason);
      // A zero timeout still gets one immediate attempt; positive deadlines include directory setup.
      if (performance.now() >= deadline && (options.timeout !== 0 || !first)) {
        throw new StorageError('ESTORAGE_TIMEOUT', 'lock', 'Timed out waiting for the record lock.', failure);
      }
      first = false;
      try {
        const release = await locking.lock(join(this.#directory, name), {
          realpath: false,
          stale: 5000,
          update: 1000,
          retries: 0,
          onCompromised: compromised,
        });
        if (options.signal?.aborted) {
          try {
            await release();
          } catch (cause) {
            throw new StorageError('ESTORAGE_ABORTED', 'lock', 'Lock acquisition was aborted, but the acquired lock could not be released.', cause);
          }
          throw new StorageError('ESTORAGE_ABORTED', 'lock', 'Lock acquisition was aborted.', options.signal.reason);
        }
        return release;
      } catch (cause) {
        if (cause instanceof StorageError) throw cause;
        if (cause.code !== 'ELOCKED') throw new StorageError('ESTORAGE_ACCESS', 'lock', 'Could not acquire the private record lock.', cause);
        failure = cause;
        if (performance.now() >= deadline) throw new StorageError('ESTORAGE_TIMEOUT', 'lock', 'Timed out waiting for the record lock.', cause);
      }
      try {
        await pause(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal: options.signal });
      } catch (cause) {
        throw new StorageError('ESTORAGE_ABORTED', 'lock', 'Lock acquisition was aborted.', cause);
      }
    }
  }
}
