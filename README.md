# cli-storage

Private JSON records for command line applications, with persistent native key protection and renewable process locks.

## Vision and scope

`cli-storage` gives independent CLI processes a small, reusable storage contract: read, replace, delete, inspect, and perform work under a record lease. It owns serialization, storage locations, native encryption keys, encrypted payload files, private file access, atomic replacement, backend selection, and stale lock recovery. Applications own record schemas and business decisions. The package has no authentication protocol, token naming convention, provider discovery, or application configuration format.

Version 1 is an asynchronous ES module for Node.js 22.9 and newer. It replaces the synchronous 0.x API. Existing 0.x files are never discovered, decrypted, migrated, or overwritten automatically.

## Installation

Install the package in the CLI that needs storage. The optional native dependency supplies prebuilt bindings where available; fresh `auto` stores can use the file backend when native protection is unavailable.

```sh
npm install cli-storage
```

## Store and inspect a record

This example saves a JSON record under an application namespace, then reads it through the same public API. The first write chooses and persists the backend. Inspecting status makes the protection level visible to the application; a file backend includes a warning string.

```js
import { Storage } from 'cli-storage';

const store = new Storage({ namespace: 'example-cli' });
await store.set('preferences', { theme: 'dark', notifications: false });
const preferences = await store.get('preferences');
console.log(preferences.theme); // dark
console.log(await store.status('preferences'));
```

The constructor performs no filesystem or keyring I/O. `status()` and `get()` create no directories or files. A missing record reads as `undefined`; malformed, inaccessible, incompatible, or undecryptable data throws an error instead.

## Backend selection and protection

| Option | Behavior for a fresh namespace |
| --- | --- |
| `auto` (default) | Prefer persistent native key protection. Use private files on headless Linux without a session bus, unsupported operating systems, an absent native binding, or a specifically recognized unavailable credential service. |
| `native` | Require native key protection. Fail explicitly if it cannot be used. |
| `file` | Store plaintext JSON records in files. Status includes a protection warning. |

Selection happens on the first `set()`, including a lease's `set()`. It is persisted in namespace metadata. `auto` always follows that persisted backend, even if a desktop keyring later appears or disappears. An explicit backend that differs from persisted metadata fails with `ESTORAGE_BACKEND`; it never migrates data implicitly. A denied or locked keyring fails explicitly and does not trigger file fallback. Existing native records never downgrade to plaintext after a keyring failure, a missing key, or corruption.

The native backend uses [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) to store one random 256-bit key per namespace in macOS Keychain, Windows Credential Manager, or Linux Secret Service. Linux explicitly pins Secret Service rather than accepting a session-only kernel keyring fallback. Native records use AES-256-GCM, a fresh 96-bit IV, an authentication tag, and authenticated namespace/key identity. Payloads live in atomic encrypted files, so record size is not constrained by a credential manager's small entry limit. The namespace key remains in the credential service after deleting its last record, allowing later records to use the same namespace. Deleting a record removes its payload; it does not securely erase filesystem snapshots, backups, or SSD blocks.

The file backend does not encrypt records. On POSIX systems, the root and namespace directories must belong to the current user and have mode `0700`; records and metadata must be regular files owned by that user with mode `0600`. Unsafe entries and final-component symlinks are rejected rather than repaired or followed. Newly created directories/files receive these modes. Locks contain no record contents and sit inside the private namespace directory.

On Windows, Node.js cannot enforce or inspect owner/group permission bits: see the [official file mode caveat](https://nodejs.org/api/fs.html#file-modes). Files and directories inherit Windows ACLs. The default location is inside the current user's application data directory. A supplied `directory` must already have appropriate per-user ACLs, including inherited child access. This package does not validate or rewrite Windows ACLs; its file-backend warning says so. Native encryption remains the default protection on Windows. Neither backend prevents code running as the same user or an administrator from accessing records.

Native key material is cleared from temporary Buffers after cryptographic use. JavaScript strings and operating system credential caches cannot be reliably erased by this package. Record names are hashed for filenames; hashing does not make low-entropy names secret. Metadata reveals the namespace and selected backend.

## Locations and file format

The default root is `envPaths('cli-storage', { suffix: '' }).data`, using [`env-paths`](https://github.com/sindresorhus/env-paths) for the current platform. Typical locations are `~/Library/Application Support/cli-storage` on macOS, `%LOCALAPPDATA%\cli-storage\Data` on Windows, and `$XDG_DATA_HOME/cli-storage` or `~/.local/share/cli-storage` on Linux. `directory` replaces that root and is resolved against the current working directory once at construction.

Each namespace has a SHA-256-named child directory. Its `metadata.json` records format version `1`, the namespace, and sticky backend; native metadata also records its keyring account identifier. Each record is a SHA-256-named `.json` envelope with format version, identity, backend, and either a plaintext `value` or encrypted `iv`, `tag`, and `data` fields. Arbitrary keys, including `../value` and `__proto__`, never become filesystem paths or object properties on a shared record map.

For a native backup, preserve both the namespace directory and its keyring credential. Copying encrypted files alone is insufficient. Preserve the directory permissions and metadata. Restore access or restore a known-good backup when corruption occurs; a failed read must not be treated as an empty store. Record replacement first checks existing data, so `set()` and `delete()` also refuse a corrupt record. An unknown format version is an error.

## Lock a read-modify-write operation

This example increments a record across multiple cooperating CLI processes without losing updates. The callback receives methods already bound to its key; they operate under the same lock and return the final counter as the callback result.

```js
import { Storage } from 'cli-storage';

const store = new Storage({ namespace: 'example-cli' });
const count = await store.lock('runs', async function increment(lease) {
  const current = await lease.get();
  const next = (current ?? 0) + 1;
  await lease.set(next);
  return next;
});
console.log(count);
```

`set()` and `delete()` acquire the same per-record process lock automatically. `get()` reads atomic snapshots without acquiring a lock; use `lease.get()` when the value participates in a transaction. Different keys can proceed concurrently. A lease is exclusive only within its namespace/root and only among cooperating processes. It does not make writes across multiple records atomic; put a related aggregate in one record when it needs one lease.

Locks use [`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile), with atomic directory creation, a 1-second heartbeat, and a 5-second stale interval. A long-running callback renews ownership throughout its work. A killed process leaves a lock that another process can recover once stale. JavaScript event-loop stalls longer than the stale interval, suspension, filesystem clock behavior, and storage failures can compromise ownership. A compromised lease fails with `ESTORAGE_COMPROMISED` and refuses subsequent mutations. Atomic writes use [`write-file-atomic`](https://github.com/npm/write-file-atomic) with file synchronization and mode `0600`. Atomic replacement prevents partial JSON reads; it is not a guarantee against every power-loss or filesystem failure.

Await lease methods inside the callback. Operations already initiated are drained before releasing its lock; calls made after callback completion reject with `ESTORAGE_LEASE`. Use the lease's methods inside the callback: calling public `set()`, `delete()`, or another `lock()` for the same key would wait for the lock already owned by that callback. Do not retain the lease for later work.

<details>
<summary>Cancel or limit lock acquisition</summary>

This example limits how long a second process waits for a busy record. The signal and timeout control acquisition only. Once the callback starts, its lock stays held until the callback and initiated lease operations finish; cancellation never releases ownership underneath ongoing work.

```js
const controller = new AbortController();
await store.lock('runs', async function update(lease) {
  await lease.set((await lease.get() ?? 0) + 1);
}, { signal: controller.signal, timeout: 5000 });
```

An already-aborted signal fails before creating directories. `timeout: 0` makes one immediate acquisition attempt. Omitting `timeout` waits indefinitely. A callback exception is propagated after its lock is released. Callback writes already completed remain committed; a lease is not a rollback transaction.

</details>

## API reference

The only runtime export is the named `Storage` class. Every method is asynchronous except its constructor. Runtime failures are `Error` instances named `StorageError`; there is no exported error constructor to couple callers to.

### TypeScript declarations

The package bundles `index.d.ts` and resolves it through a `types` export condition. The declarations preserve the awaited return type of a lock callback. They export these types in addition to the `Storage` class; each field and method has the contract described in the corresponding API section below.

| Exported type | Signature and fields |
| --- | --- |
| `StorageValue` | `null \| boolean \| number \| string \| readonly StorageValue[] \| { readonly [key: string]: StorageValue }`. Runtime checks enforce finite values, plain objects, and the other JSON rules below. |
| `StorageOptions` | Readonly `{ namespace: string; directory?: string; backend?: 'auto' \| 'native' \| 'file' }`. Constructor options. |
| `StorageLockOptions` | Readonly `{ signal?: AbortSignal; timeout?: number }`. Acquisition controls. |
| `StorageLease` | `get(): Promise<StorageValue \| undefined>`, `set(value: StorageValue): Promise<void>`, `delete(): Promise<boolean>`. Methods bound to one active key. |
| `StorageStatus` | Readonly `{ namespace: string; directory: string; backend: 'native' \| 'file' \| null; warning: string \| null; exists?: boolean }`. Passive inspection result. |

The class signatures are `constructor(options: StorageOptions)`, `get(key: string): Promise<StorageValue | undefined>`, `set(key: string, value: StorageValue): Promise<void>`, `delete(key: string): Promise<boolean>`, `status(key?: string): Promise<StorageStatus>`, and `lock<T>(key: string, work: (lease: StorageLease) => T, options?: StorageLockOptions): Promise<Awaited<T>>`. Standard Node.js type definitions or the DOM library must supply the global `AbortSignal` type. Static types cannot prove private permissions, finite numbers, acyclic data, or active lease ownership; runtime validation remains authoritative.

### `new Storage({ namespace, directory?, backend? })`

| Option | Type | Default | Contract |
| --- | --- | --- | --- |
| `namespace` | Nonempty well-formed Unicode string | Required | Application-owned identity; distinct namespaces are isolated. |
| `directory` | Nonempty well-formed Unicode string | Platform data root | Root containing hashed namespace directories. Existing POSIX root must already be private; Windows ACL requirements are described above. |
| `backend` | `'auto' \| 'native' \| 'file'` | `'auto'` | Preference used to initialize a fresh namespace; explicit mismatch fails for existing data. |

Returns a `Storage` instance. It performs no I/O and throws `ESTORAGE_OPTIONS` for invalid options. Constructor options are runtime values, not keys added to application or MCP configuration files.

### `await store.get(key)`

`key` is a nonempty well-formed Unicode string. Resolves to a fresh parsed JSON value or `undefined` when the record is absent. It writes nothing and never interprets corruption or denied access as absence. It may reject with key, access, corruption, backend, or native errors.

### `await store.set(key, value)`

`key` is a nonempty well-formed Unicode string. `value` supports `null`, booleans, finite numbers, strings, dense arrays, and plain objects containing the same. Plain objects may have a null prototype. All properties must be enumerable data properties. Unsupported values, cycles, sparse/decorated arrays, symbol properties, getters/setters, non-enumerable properties, class instances, `undefined`, functions, symbols, `bigint`, `NaN`, and infinities are rejected with `ESTORAGE_VALUE`. Inputs are snapshotted before asynchronous work; later caller mutations do not change the stored value. JSON number serialization normalizes negative zero to zero.

Resolves to `undefined` after atomic replacement. It acquires the record lock and initializes a namespace on its first write. It may reject with validation, lock, access, corruption, backend, or native errors. Existing corrupt records are preserved for recovery.

### `await store.delete(key)`

`key` is a nonempty well-formed Unicode string. Resolves to `true` when a record was removed and `false` if it was absent. It acquires the record lock and may create lock directories even when a record is absent. Namespace metadata and the native namespace key remain. It may reject with key, lock, access, corruption, backend, or native errors.

### `await store.lock(key, work, { signal?, timeout? }?)`

`key` is a nonempty well-formed Unicode string; `work` is a callback receiving one frozen bound lease. `signal` is an optional `AbortSignal`; `timeout` is an optional finite nonnegative number of milliseconds. Both apply only to acquiring the lock, including asynchronous filesystem lock creation. The default acquisition wait has no deadline. Resolves to the awaited callback result after initiated lease operations drain and the lock releases. It may reject with key/options, acquisition, compromise, access, lease, record/native errors, or the callback's own exception.

| Bound lease method | Arguments | Result |
| --- | --- | --- |
| `await lease.get()` | None | Same record value/absence contract as `get(key)`. |
| `await lease.set(value)` | Supported JSON data | `undefined` after replacing the record under the existing lock. |
| `await lease.delete()` | None | Boolean indicating whether the record was removed. |

Lease methods never reacquire the key's lock. They share the corresponding public record method's validation and error behavior, and add `ESTORAGE_LEASE` after the lease closes or `ESTORAGE_COMPROMISED` after lost ownership.

### `await store.status(key?)`

`key` is an optional nonempty well-formed Unicode string. Resolves to the following plain object without writing files, acquiring locks, loading native bindings, or querying native credentials. It validates filesystem entries, metadata, and the optional envelope. It does not decrypt a native record, so it cannot authenticate its ciphertext or prove that its native key is available.

| Field | Type | Meaning |
| --- | --- | --- |
| `namespace` | `string` | Configured namespace. |
| `directory` | `string` | Absolute hashed namespace directory, whether or not created. |
| `backend` | `'native' \| 'file' \| null` | Persisted backend; the explicit preference for a fresh store; `null` for uninitialized `auto`. |
| `warning` | `string \| null` | Plaintext protection notice for `file`; otherwise `null`. Windows notice refers to inherited ACLs. |
| `exists` | `boolean` (optional) | Envelope presence when a key was supplied; omitted otherwise. |

May reject with key, access, corruption, or backend errors. Metadata absence alongside record files is corruption. `status()` does not claim that the next native operation will succeed.

## Errors

Every package-generated error has `name: 'StorageError'`, `package: 'cli-storage'`, `method`, stable `code`, stable `reference`, and a generated documentation `url`. An underlying failure is preserved as `cause` when available. User callback exceptions are propagated as supplied. Record values are excluded from package-generated error messages.

This example branches on a machine-readable code to report contention. It rethrows every other failure so a damaged store is never interpreted as missing data.

```js
try {
  await store.lock('runs', async function inspect(lease) {
    console.log(await lease.get());
  }, { timeout: 1000 });
} catch (error) {
  if (error.code === 'ESTORAGE_TIMEOUT') console.error('Another process is still working.');
  else throw error;
}
```

| Code and reference | Meaning and response |
| --- | --- |
| <a id="estorage-options"></a>`ESTORAGE_OPTIONS` / `estorage-options` | Invalid constructor or lock options. Correct the caller. |
| <a id="estorage-key"></a>`ESTORAGE_KEY` / `estorage-key` | Empty, non-string, or malformed Unicode record key. Supply a stable nonempty string containing well-formed Unicode. |
| <a id="estorage-value"></a>`ESTORAGE_VALUE` / `estorage-value` | Unsupported JSON data. Convert explicitly before writing. |
| <a id="estorage-access"></a>`ESTORAGE_ACCESS` / `estorage-access` | Filesystem I/O, ownership, entry type, or permissions failure. Restore private access; no silent chmod or data replacement occurs. |
| <a id="estorage-corrupt"></a>`ESTORAGE_CORRUPT` / `estorage-corrupt` | Invalid metadata/envelope/JSON/key encoding, orphaned records, unsupported version, or failed authenticated decryption. Restore known-good data and native keys. |
| <a id="estorage-backend"></a>`ESTORAGE_BACKEND` / `estorage-backend` | Explicit backend conflicts with persisted selection. Use the persisted backend or `auto`. |
| <a id="estorage-native-unavailable"></a>`ESTORAGE_NATIVE_UNAVAILABLE` / `estorage-native-unavailable` | Native binding, platform, or credential service unavailable. Only a fresh `auto` initialization may fall back. |
| <a id="estorage-native-access"></a>`ESTORAGE_NATIVE_ACCESS` / `estorage-native-access` | Native access denied, keychain locked, or key persistence failed. Restore service access; no downgrade occurs. |
| <a id="estorage-native-key"></a>`ESTORAGE_NATIVE_KEY` / `estorage-native-key` | Persisted namespace key missing from native credentials. Restore that key; a replacement is never silently generated for existing data. |
| <a id="estorage-aborted"></a>`ESTORAGE_ABORTED` / `estorage-aborted` | Acquisition cancelled before the callback started. Retry when appropriate. |
| <a id="estorage-timeout"></a>`ESTORAGE_TIMEOUT` / `estorage-timeout` | Busy lock exceeded the acquisition timeout. The holder keeps ownership. |
| <a id="estorage-compromised"></a>`ESTORAGE_COMPROMISED` / `estorage-compromised` | Heartbeat ownership lost or release failed. Stop using this lease and investigate before retrying side effects. |
| <a id="estorage-lease"></a>`ESTORAGE_LEASE` / `estorage-lease` | A bound lease was used after callback completion. Keep work inside the callback. |

## Migrating from 0.x

Version 1 intentionally removes CommonJS/default export, the positional name/options constructor, synchronous methods, dotfile discovery, SSH/hostname-derived encryption, passwords, parser registration, whitelisting/default merging, `del()`, `load()`, `save()`, `read()`, `file()`, `remove()`, and `destroy()`. There are no compatibility aliases. Replace `require('cli-storage')` with `import { Storage } from 'cli-storage'`, pass `{ namespace }`, await operations, and replace `del(key)` with `delete(key)`.

Keep a backup of existing 0.x data and use the old version in a separate controlled migration program to export records you can successfully decrypt. Validate and convert that data to the JSON contract, then explicitly write it into a new version-1 namespace. Compare the imported values before retiring the old files. Version 1 does not accept legacy encryption options or automatically read old files, and it uses a separate platform data location rather than overwriting a legacy dotfile. Never treat a failed legacy decryption as an empty export.

## Development and verification

The suite exercises the public API against actual temporary files, real child processes, and the operating system credential service when accessible. Native tests use unique temporary namespaces and delete their own temporary keyring entries. An inaccessible native service is reported as a skip; no keyring or filesystem mocks are used. Linux headless selection has its own real-process test. POSIX permission/symlink tests are platform-specific. A strict TypeScript consumer is compiled and executed after installing the real packed tarball, checking published declarations and runtime exports together. CI covers Node.js 22, 24, and 26 on Linux, macOS, and Windows.

Install the pinned dependency graph and run all tests with the following commands. Expected results include successful contention, heartbeat, killed-owner recovery, file integrity, and JSON contract checks. The lock recovery test takes several seconds because it crosses the real stale interval.

```sh
npm ci
npm test
```

## License

MIT. See [LICENSE](LICENSE).
