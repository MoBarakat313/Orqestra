import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateConfig } from '../src/core/migration.js';
import { createPreset } from '../src/presets.js';
import { migrateConfigFile } from '../src/runtime/config-migration.js';
import { setupProject } from '../src/runtime/setup.js';
import { uninstallSkill } from '../src/runtime/skill-install.js';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'orqestra-migration-test-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function schemaOne(): Record<string, unknown> {
  const current = structuredClone(createPreset()) as unknown as Record<string, unknown>;
  current.schemaVersion = 1;
  delete (current.limits as Record<string, unknown>).turnTimeoutSeconds;
  return current;
}

test('schema 1 policies migrate deterministically without changing the input object', () => {
  const input = schemaOne();
  const before = JSON.stringify(input);
  const result = migrateConfig(input);
  assert.equal(result.changed, true);
  assert.equal(result.fromVersion, 1);
  assert.equal(result.config.schemaVersion, 2);
  assert.equal(result.config.limits.turnTimeoutSeconds, 900);
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => migrateConfig({ ...input, schemaVersion: 0 }), /no migration is available/);
});

test('file migration writes a byte-preserving backup and is then a no-op', async () => {
  await fixture(async root => {
    const path = join(root, 'policy.json');
    const original = JSON.stringify(schemaOne(), null, 2) + '\n';
    await writeFile(path, original, { mode: 0o600 });
    const migrated = await migrateConfigFile(path);
    assert.equal(migrated.changed, true);
    assert.equal(await readFile(migrated.backup!, 'utf8'), original);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).limits.turnTimeoutSeconds, 900);
    const repeated = await migrateConfigFile(path);
    assert.deepEqual(repeated, { path, backup: null, fromVersion: 2, toVersion: 2, changed: false });
  });
});

test('migration refuses to replace an existing backup', async () => {
  await fixture(async root => {
    const path = join(root, 'policy.json');
    const original = JSON.stringify(schemaOne());
    await writeFile(path, original);
    await writeFile(`${path}.v1.bak`, 'preserve me');
    await assert.rejects(migrateConfigFile(path), /backup already exists/);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(await readFile(`${path}.v1.bak`, 'utf8'), 'preserve me');
    assert.deepEqual((await readdir(root)).sort(), ['policy.json', 'policy.json.v1.bak']);
  });
});

test('guided setup creates a policy and skill and is safe to repeat', async () => {
  await fixture(async root => {
    const first = await setupProject(root, 'economy');
    assert.equal(first.config.action, 'created');
    assert.equal(first.skill.action, 'installed');
    assert.equal(JSON.parse(await readFile(join(root, 'orqestra.config.json'), 'utf8')).profile, 'economy');
    const second = await setupProject(root, 'quality');
    assert.equal(second.config.action, 'preserved');
    assert.equal(second.skill.action, 'current');
    assert.equal(JSON.parse(await readFile(join(root, 'orqestra.config.json'), 'utf8')).profile, 'economy');
    await uninstallSkill(root);
    assert.equal(JSON.parse(await readFile(join(root, 'orqestra.config.json'), 'utf8')).schemaVersion, 2);
  });
});

test('guided setup migrates an existing schema 1 policy with a backup', async () => {
  await fixture(async root => {
    const original = JSON.stringify(schemaOne(), null, 2) + '\n';
    await writeFile(join(root, 'orqestra.config.json'), original);
    const result = await setupProject(root, 'balanced');
    assert.equal(result.config.action, 'migrated');
    assert.equal(await readFile(result.config.backup!, 'utf8'), original);
    assert.equal(result.skill.action, 'installed');
  });
});
