import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ORQESTRA_VERSION } from '../src/version.js';

const source = fileURLToPath(new URL('../../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command: string, args: string[], cwd: string, cache: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, npm_config_cache: cache } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('the public archive installs and manages a project outside the source checkout', { timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'orqestra-package-test-'));
  try {
    const archive = join(root, 'archive');
    const prefix = join(root, 'prefix');
    const project = join(root, 'project');
    const cache = join(root, 'npm-cache');
    await mkdir(archive);
    await mkdir(project);
    const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', archive], source, cache))[0];
    assert.equal(packed.version, ORQESTRA_VERSION);
    const files = packed.files.map((item: { path: string }) => item.path as string);
    for (const forbidden of ['.references', '.orqestra', '.env', 'node_modules', 'tests/', 'orqestra.config.json']) {
      assert.equal(files.some((path: string) => path === forbidden || path.startsWith(`${forbidden}/`) || path.startsWith(forbidden)), false, forbidden);
    }
    const privatePattern = /\/Users\/|BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
    for (const path of files) {
      assert.doesNotMatch(await readFile(join(source, path), 'utf8'), privatePattern, `private-looking content in ${path}`);
    }
    const tarball = join(archive, packed.filename);
    run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball], root, cache);
    const cli = join(prefix, 'node_modules', '@mobarakat313', 'orqestra', 'dist', 'src', 'cli.js');
    assert.equal(JSON.parse(run(process.execPath, [cli, 'version', '--json'], root, cache)).version, ORQESTRA_VERSION);
    const setup = JSON.parse(run(process.execPath, [cli, 'setup', '--project', project, '--json'], root, cache));
    assert.equal(setup.skill.action, 'installed');
    const helper = join(project, '.agents', 'skills', 'orqestra', 'scripts', 'orqestra.mjs');
    assert.equal(JSON.parse(run(process.execPath, [helper, 'demo', '--json'], project, cache)).mode, 'offline-demo');
    assert.equal(JSON.parse(run(process.execPath, [cli, 'skill-status', '--project', project, '--json'], root, cache)).current, true);
    run(process.execPath, [cli, 'upgrade-skill', '--project', project, '--json'], root, cache);
    run(process.execPath, [cli, 'uninstall-skill', '--project', project, '--json'], root, cache);
    assert.equal(JSON.parse(await readFile(join(project, 'orqestra.config.json'), 'utf8')).schemaVersion, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
