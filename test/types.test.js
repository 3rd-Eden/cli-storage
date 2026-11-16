import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

describe('cli-storage', /**
 * Register verification of published declarations.
 * @returns {void}
 */ function storage() {
  describe('published types', /**
   * Register packed consumer compilation and execution coverage.
   * @returns {void}
   */ function types() {
    it('compiles and executes a strict TypeScript consumer installed from the real tarball', { timeout: 120000 }, /**
     * Verify conditional type exports and the published runtime together.
     * @returns {Promise<void>} Successful compiler and runtime verification.
     */ async function consumer() {
      const directory = await mkdtemp(join(tmpdir(), 'cli-storage-types-'));
      const npm = process.env.npm_execpath;
      assert.equal(typeof npm, 'string', 'Run packed type verification with npm test.');
      try {
        const packed = await execute(process.execPath, [npm, 'pack', '--json', '--pack-destination', directory], { cwd: root });
        const [archive] = JSON.parse(packed.stdout);
        await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
        await copyFile(new URL('./fixtures/consumer.ts', import.meta.url), join(directory, 'consumer.ts'));
        await copyFile(new URL('./fixtures/consumer.json', import.meta.url), join(directory, 'tsconfig.json'));
        await execute(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(directory, archive.filename)], { cwd: directory });
        await execute(process.execPath, [compiler, '--project', join(directory, 'tsconfig.json')], { cwd: directory });
        const result = await execute(process.execPath, [join(directory, 'output', 'consumer.js')], { cwd: directory });
        assert.match(result.stdout, /typed consumer passed/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
