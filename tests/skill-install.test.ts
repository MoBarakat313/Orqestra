import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSkillBundle, installSkill, uninstallSkill } from '../src/runtime/skill-install.js';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'orqestra-install-test-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('project installation bundles a working helper without changing existing instructions', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'AGENTS.md'), 'Keep these instructions');
    await writeFile(join(root, 'package.json'), '{"type":"commonjs"}');
    await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.codex', 'config.toml'), 'model = "keep"');
    const { installed } = await installSkill(root);
    const result = spawnSync(process.execPath, [join(installed, 'scripts', 'orqestra.mjs'), 'demo', '--json'], { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).mode, 'offline-demo');
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'Keep these instructions');
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), '{"type":"commonjs"}');
    assert.equal(await readFile(join(root, '.codex', 'config.toml'), 'utf8'), 'model = "keep"');
    assert.match(await readFile(join(installed, 'LICENSE'), 'utf8'), /MIT License/);
    await uninstallSkill(root);
    assert.deepEqual(await readdir(join(root, '.agents', 'skills')), []);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'Keep these instructions');
  });
});

test('installer refuses to overwrite an existing skill or partial installation', async () => {
  await fixture(async root => {
    const { installed } = await installSkill(root);
    const before = await readFile(join(installed, 'SKILL.md'), 'utf8');
    await assert.rejects(installSkill(root), /EEXIST/);
    assert.equal(await readFile(join(installed, 'SKILL.md'), 'utf8'), before);
  });
});

test('uninstaller preserves modified and added files', async () => {
  await fixture(async root => {
    const { installed } = await installSkill(root);
    const path = join(installed, 'SKILL.md');
    const before = await readFile(path, 'utf8');
    await writeFile(path, before + '\nMy custom instruction');
    await assert.rejects(uninstallSkill(root), /modified artifact/);
    assert.match(await readFile(path, 'utf8'), /My custom instruction/);
    await writeFile(path, before);
    await writeFile(join(installed, 'my-notes.txt'), 'Keep me');
    await assert.rejects(uninstallSkill(root), /files were added or removed/);
    assert.equal(await readFile(join(installed, 'my-notes.txt'), 'utf8'), 'Keep me');
  });
});

test('uninstaller rejects corrupt ownership manifests', async () => {
  await fixture(async root => {
    const { installed } = await installSkill(root);
    await writeFile(join(installed, '.orqestra-manifest.json'), 'null');
    await assert.rejects(uninstallSkill(root), /unrecognized ownership/);
    assert.match(await readFile(join(installed, 'SKILL.md'), 'utf8'), /name: orqestra/);
  });
});

test('uninstaller preserves newly added empty directories', async () => {
  await fixture(async root => {
    const { installed } = await installSkill(root);
    await mkdir(join(installed, 'my-directory'));
    await assert.rejects(uninstallSkill(root), /unexpected empty directory/);
    assert.deepEqual(await readdir(join(installed, 'my-directory')), []);
  });
});

test('symlinked skill containers cannot redirect installation outside the requested project', async () => {
  await fixture(async root => {
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    await mkdir(project);
    await mkdir(outside);
    await symlink(outside, join(project, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(installSkill(project), /real directory/);
    assert.deepEqual(await readdir(outside), []);
  });
});

test('partial write failure rolls back newly created installation files and parents', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'AGENTS.md'), 'Preserve');
    const bundle = await buildSkillBundle();
    // A file/directory collision forces failure after the helper has been copied.
    bundle.set('scripts', Buffer.from('collision'));
    await assert.rejects(installSkill(root, bundle));
    assert.deepEqual(await readdir(root), ['AGENTS.md']);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'Preserve');
  });
});

test('artifact traversal is rejected before filesystem mutations', async () => {
  await fixture(async root => {
    const bundle = await buildSkillBundle();
    bundle.set('../escape', Buffer.from('bad'));
    await assert.rejects(installSkill(root, bundle), /Invalid skill artifact path/);
    assert.deepEqual(await readdir(root), []);
  });
});

test('a bundled project helper can install another independent project copy', async () => {
  await fixture(async root => {
    const other = join(root, 'other');
    await mkdir(other);
    const { installed } = await installSkill(root);
    const result = spawnSync(process.execPath, [join(installed, 'scripts', 'orqestra.mjs'), 'install-skill', '--project', other, '--json'], { cwd: other, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const second = JSON.parse(result.stdout).installed;
    const demo = spawnSync(process.execPath, [join(second, 'scripts', 'orqestra.mjs'), 'demo', '--json'], { cwd: other, encoding: 'utf8', timeout: 10000 });
    assert.equal(demo.status, 0, demo.stderr);
    await uninstallSkill(other);
  });
});
