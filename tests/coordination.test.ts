import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoordinationContract } from '../src/core/coordination.js';
import { createPreset } from '../src/presets.js';
import { resumeCoordinated, runCoordinated } from '../src/runtime/coordinator.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const workerFixture = fileURLToPath(new URL('./fixtures/fake-worker-codex.js', import.meta.url));
const verifier = fileURLToPath(new URL('./fixtures/verify-file.js', import.meta.url));
const filesVerifier = fileURLToPath(new URL('./fixtures/verify-files.js', import.meta.url));
const standard = { role: 'implement' as const, alias: 'balanced', id: 'gpt-5.6-terra', runtime: 'codex', reasoning: 'medium', group: 'standard' as const, reason: 'fixture' };
const premium = { ...standard, alias: 'quality', group: 'premium' as const };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function projectFixture(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'orqestra-coordinate-test-'));
  try {
    git(cwd, 'init', '--quiet');
    git(cwd, 'config', 'user.email', 'fixture@example.invalid');
    git(cwd, 'config', 'user.name', 'Fixture');
    await writeFile(join(cwd, 'README.md'), 'fixture\n');
    git(cwd, 'add', 'README.md');
    git(cwd, 'commit', '--quiet', '-m', 'fixture');
    await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

function contract(finalExpected = ['a', 'b', 'c']) {
  const packages = [
    { id: 'a', dependsOn: [], ownedPaths: ['packages/a.txt'] },
    { id: 'b', dependsOn: [], ownedPaths: ['packages/b.txt'] },
    { id: 'c', dependsOn: ['a'], ownedPaths: ['packages/c.txt'] },
  ];
  return parseCoordinationContract({
    schemaVersion: 1,
    task: { objective: 'Build three isolated packages', complexity: 'complex', risk: 'low', ambiguity: 'clear', independentPackages: 3 },
    packages: packages.map(item => ({
      ...item, objective: `Build package ${item.id}`, acceptanceCriteria: [`Package ${item.id} is complete`],
      verification: [{ name: `verify ${item.id}`, command: [process.execPath, verifier, `packages/${item.id}.txt`, `done ${item.id}`], timeoutSeconds: 10 }],
    })),
    verification: [{ name: 'verify integration', command: [process.execPath, filesVerifier, ...finalExpected.map(id => `packages/${id}.txt`)], timeoutSeconds: 10 }],
  });
}

async function environment<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await action(); }
  finally {
    for (const [key, value] of before) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test('coordination contracts reject cycles, unknown dependencies, traversal, and overlapping ownership', () => {
  const raw = JSON.parse(JSON.stringify(contract())) as { task: { independentPackages: number }; packages: Array<{ id: string; dependsOn: string[]; ownedPaths: string[] }> };
  raw.packages[0]!.dependsOn = ['c'];
  assert.throws(() => parseCoordinationContract(raw), /cycle/);
  raw.packages[0]!.dependsOn = ['missing'];
  assert.throws(() => parseCoordinationContract(raw), /unknown package/);
  raw.packages[0]!.dependsOn = [];
  raw.packages[0]!.ownedPaths = ['../secret'];
  assert.throws(() => parseCoordinationContract(raw), /normalized repository-relative/);
  raw.packages[0]!.ownedPaths = ['packages'];
  assert.throws(() => parseCoordinationContract(raw), /overlapping owned paths/);
  raw.packages[0]!.ownedPaths = ['packages/a.txt'];
  raw.task.independentPackages = 2;
  assert.throws(() => parseCoordinationContract(raw), /must equal/);
});

test('isolated packages honor dependencies and integrate without touching the original checkout', async () => {
  await projectFixture(async project => {
    const events = join(tmpdir(), `orqestra-events-${Date.now()}-${Math.random()}`);
    const base = git(project, 'rev-parse', 'HEAD');
    try {
      const result = await environment({ ORQESTRA_WORKER_SCENARIO: 'coordinate', ORQESTRA_WORKER_EVENTS_FILE: events, ORQESTRA_REQUIRED_DEPENDENCY: 'c:a' }, () =>
        runCoordinated(contract(), standard, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 1, maxWorkers: 2, maxPremiumWorkers: 1 }));
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.equal(result.maxConcurrentObserved, 2);
      assert.equal(result.maxPremiumObserved, 0);
      assert(result.packages.every(item => item.status === 'committed' && item.commit));
      assert.equal((await readFile(join(result.integration.worktree, 'packages/c.txt'), 'utf8')).trim(), 'done c');
      assert.deepEqual(result.integration.changedFiles.sort(), ['packages/a.txt', 'packages/b.txt', 'packages/c.txt']);
      assert.equal(git(project, 'rev-parse', 'HEAD'), base);
      assert.equal(git(project, 'status', '--porcelain'), '');
      const lines = (await readFile(events, 'utf8')).trim().split('\n').map(line => line.split(','));
      const endA = Number(lines.find(([kind, id]) => kind === 'end' && id === 'a')?.[2]);
      const startC = Number(lines.find(([kind, id]) => kind === 'start' && id === 'c')?.[2]);
      assert(startC >= endA);
      const saved = await readFile(result.statePath, 'utf8');
      assert.equal(JSON.parse(saved).integration.owner, 'orqestra');
      assert.equal(saved.includes(filesVerifier), false);
      assert.equal(saved.includes('Build three isolated packages'), false);
      const beforeResume = (await readFile(events, 'utf8')).trim().split('\n').length;
      const resumed = await environment({ ORQESTRA_WORKER_SCENARIO: 'coordinate', ORQESTRA_WORKER_EVENTS_FILE: events }, () =>
        resumeCoordinated(result.runId, contract(), standard, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 1, maxWorkers: 2, maxPremiumWorkers: 1 }));
      assert.equal(resumed.status, 'succeeded');
      assert.equal((await readFile(events, 'utf8')).trim().split('\n').length, beforeResume);
    } finally { await rm(events, { force: true }); }
  });
});

test('premium concurrency is hard-capped at one', async () => {
  await projectFixture(async project => {
    const events = join(tmpdir(), `orqestra-premium-events-${Date.now()}-${Math.random()}`);
    try {
      const result = await environment({ ORQESTRA_WORKER_SCENARIO: 'coordinate', ORQESTRA_WORKER_EVENTS_FILE: events }, () =>
        runCoordinated(contract(), premium, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 1, maxWorkers: 3, maxPremiumWorkers: 1 }));
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.equal(result.maxConcurrentObserved, 1);
      assert.equal(result.maxPremiumObserved, 1);
      const lines = (await readFile(events, 'utf8')).trim().split('\n').map(line => line.split(','));
      for (let index = 0; index < lines.length; index += 2) assert.deepEqual(lines[index]?.[0], 'start');
    } finally { await rm(events, { force: true }); }
  });
});

test('package failure blocks dependents and never creates an integrated success', async () => {
  await projectFixture(async project => {
    const result = await environment({ ORQESTRA_WORKER_SCENARIO: 'coordinate', ORQESTRA_FAIL_PACKAGE: 'a' }, () =>
      runCoordinated(contract(), standard, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 1, maxWorkers: 2, maxPremiumWorkers: 1 }));
    assert.equal(result.status, 'package-failed');
    assert.equal(result.packages.find(item => item.id === 'a')?.status, 'failed');
    assert.equal(result.packages.find(item => item.id === 'c')?.status, 'blocked');
    assert.equal(result.integration.status, 'pending');
  });
});

test('verified worker output outside declared ownership is never integrated', async () => {
  await projectFixture(async project => {
    const result = await environment({ ORQESTRA_WORKER_SCENARIO: 'coordinate', ORQESTRA_OUT_OF_SCOPE_PACKAGE: 'b' }, () =>
      runCoordinated(contract(), standard, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 1, maxWorkers: 2, maxPremiumWorkers: 1 }));
    assert.equal(result.status, 'package-failed');
    assert.equal(result.packages.find(item => item.id === 'b')?.failureCode, 'owned-path-violation');
    assert.equal(result.integration.status, 'pending');
    assert.equal(await stat(join(project, 'outside.txt')).then(() => true, () => false), false);
  });
});

test('cancellation stops active workers and does not exceed dispatch limits', async () => {
  await projectFixture(async project => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120);
    const result = await environment({ ORQESTRA_WORKER_SCENARIO: 'coordinate-hang' }, () =>
      runCoordinated(contract(), standard, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 1, maxWorkers: 2, maxPremiumWorkers: 1, signal: controller.signal }));
    assert.equal(result.status, 'cancelled');
    assert(result.maxConcurrentObserved <= 2);
    assert.equal(result.packages.filter(item => item.attempts > 0).length <= 2, true);
  });
});

test('paused packages resume their durable child run without redispatching committed siblings', async () => {
  await projectFixture(async project => {
    const events = join(tmpdir(), `orqestra-resume-events-${Date.now()}-${Math.random()}`);
    try {
      const paused = await environment({ ORQESTRA_WORKER_SCENARIO: 'exit-after-start', ORQESTRA_WORKER_EVENTS_FILE: events }, () =>
        runCoordinated(contract(), standard, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2, maxWorkers: 2, maxPremiumWorkers: 1 }));
      assert.equal(paused.status, 'paused');
      const resumed = await environment({ ORQESTRA_WORKER_SCENARIO: 'coordinate', ORQESTRA_WORKER_EVENTS_FILE: events }, () =>
        resumeCoordinated(paused.runId, contract(), standard, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2, maxWorkers: 2, maxPremiumWorkers: 1 }));
      assert.equal(resumed.status, 'succeeded', JSON.stringify(resumed));
      assert.equal(resumed.packages.every(item => item.status === 'committed'), true);
      assert.equal(await stat(resumed.integration.worktree).then(info => info.isDirectory()), true);
    } finally { await rm(events, { force: true }); }
  });
});

test('failed final verification preserves the integration worktree and cannot report success', async () => {
  await projectFixture(async project => {
    const result = await environment({ ORQESTRA_WORKER_SCENARIO: 'coordinate' }, () =>
      runCoordinated(contract(['missing']), standard, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 1, maxWorkers: 2, maxPremiumWorkers: 1 }));
    assert.equal(result.status, 'integration-failed');
    assert.equal(result.integration.status, 'failed');
    assert.equal((await readFile(join(result.integration.worktree, 'packages/a.txt'), 'utf8')).trim(), 'done a');
  });
});

test('coordinate CLI selects the configured implementer and returns the review worktree', async () => {
  await projectFixture(async project => {
    await writeFile(join(project, 'policy.json'), JSON.stringify(createPreset()));
    await writeFile(join(project, 'coordination.json'), JSON.stringify(contract()));
    git(project, 'add', 'policy.json', 'coordination.json');
    git(project, 'commit', '--quiet', '-m', 'coordination inputs');
    const result = spawnSync(process.execPath, [cli, 'coordinate', '--request', 'coordination.json', '--project', project,
      '--config', 'policy.json', '--codex', workerFixture, '--turn-timeout', '5', '--json'], {
      cwd: project, encoding: 'utf8', timeout: 30000, env: { ...process.env, ORQESTRA_WORKER_SCENARIO: 'coordinate' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { status: string; integration: { owner: string; worktree: string }; maxConcurrentObserved: number };
    assert.equal(report.status, 'succeeded');
    assert.equal(report.integration.owner, 'orqestra');
    assert.equal(await stat(report.integration.worktree).then(info => info.isDirectory()), true);
    assert(report.maxConcurrentObserved <= 2);
  });
});
