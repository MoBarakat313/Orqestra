import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseExecutionContract } from '../src/core/execution.js';
import { createPreset } from '../src/presets.js';
import { resumeDurable, runDurable } from '../src/runtime/durable.js';

const workerFixture = fileURLToPath(new URL('./fixtures/fake-worker-codex.js', import.meta.url));
const verifier = fileURLToPath(new URL('./fixtures/verify-file.js', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const processTreeVerifier = fileURLToPath(new URL('./fixtures/verify-process-tree.js', import.meta.url));
const assignment = { role: 'implement' as const, alias: 'balanced', id: 'gpt-5.6-terra', runtime: 'codex', reasoning: 'medium', group: 'standard' as const, reason: 'fixture' };

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function projectFixture(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'orqestra-durable-test-'));
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

function contract(expected = 'done') {
  return parseExecutionContract({
    schemaVersion: 1,
    task: { objective: 'Create result.txt with private objective text', complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 },
    acceptanceCriteria: ['result.txt contains the expected text'],
    verification: [{ name: 'result content', command: [process.execPath, verifier, 'result.txt', expected], timeoutSeconds: 10 }],
  });
}

async function scenario<T>(name: string, countFile: string, run: () => Promise<T>): Promise<T> {
  const beforeScenario = process.env.ORQESTRA_WORKER_SCENARIO;
  const beforeCount = process.env.ORQESTRA_WORKER_COUNT_FILE;
  process.env.ORQESTRA_WORKER_SCENARIO = name;
  process.env.ORQESTRA_WORKER_COUNT_FILE = countFile;
  try { return await run(); }
  finally {
    if (beforeScenario === undefined) delete process.env.ORQESTRA_WORKER_SCENARIO; else process.env.ORQESTRA_WORKER_SCENARIO = beforeScenario;
    if (beforeCount === undefined) delete process.env.ORQESTRA_WORKER_COUNT_FILE; else process.env.ORQESTRA_WORKER_COUNT_FILE = beforeCount;
  }
}

test('verification failure triggers one bounded repair and persists redacted metadata', async () => {
  await projectFixture(async project => {
    const count = join(tmpdir(), `orqestra-count-${Date.now()}-${Math.random()}`);
    try {
      const result = await scenario('repair-requires-resume', count, () => runDurable(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2 }));
      assert.equal(result.status, 'succeeded');
      assert.equal(result.attempts, 2);
      assert.equal(await readFile(join(project, 'result.txt'), 'utf8'), 'done\n');
      assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 2);
      const saved = await readFile(result.statePath, 'utf8');
      assert.equal(saved.includes('private objective text'), false);
      assert.equal(saved.includes(verifier), false);
      assert.equal(saved.includes('fixture completed'), false);
      const state = JSON.parse(saved);
      assert.equal(state.phase, 'terminal');
      assert.equal(state.attempts[0].outcome, 'verification-failed');
      assert.match(state.attempts[0].verification[0].outputSha256, /^[a-f0-9]{64}$/u);
    } finally { await rm(count, { force: true }); }
  });
});

test('resume verifies interrupted edits before starting exactly one repair worker', async () => {
  await projectFixture(async project => {
    const count = join(tmpdir(), `orqestra-count-${Date.now()}-${Math.random()}`);
    try {
      const paused = await scenario('exit-after-edit', count, () => runDurable(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2 }));
      assert.equal(paused.status, 'paused');
      assert.equal(await readFile(join(project, 'result.txt'), 'utf8'), 'incomplete\n');
      const resumed = await scenario('repair', count, () => resumeDurable(paused.runId, contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2 }));
      assert.equal(resumed.status, 'succeeded');
      assert.equal(resumed.attempts, 2);
      assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 2);
      assert.equal(await readFile(join(project, 'result.txt'), 'utf8'), 'done\n');
    } finally { await rm(count, { force: true }); }
  });
});

test('cancellation is terminal, cleans its lock, and does not retry', async () => {
  await projectFixture(async project => {
    const count = join(tmpdir(), `orqestra-count-${Date.now()}-${Math.random()}`);
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const result = await scenario('hang', count, () => runDurable(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2, signal: controller.signal }));
      assert.equal(result.status, 'cancelled');
      assert(result.attempts <= 1);
      await assert.rejects(stat(`${result.statePath}.lock`), /ENOENT/);
      const turns = await readFile(count, 'utf8').then(value => value.trim() ? value.trim().split('\n').length : 0, () => 0);
      assert(turns <= 1);
    } finally { await rm(count, { force: true }); }
  });
});

test('verification cancellation terminates its descendant process group', { skip: process.platform === 'win32' }, async () => {
  await projectFixture(async project => {
    const count = join(tmpdir(), `orqestra-count-${Date.now()}-${Math.random()}`);
    const started = join(tmpdir(), `orqestra-verifier-started-${Date.now()}-${Math.random()}`);
    const marker = join(tmpdir(), `orqestra-verifier-marker-${Date.now()}-${Math.random()}`);
    try {
      const treeContract = parseExecutionContract({
        schemaVersion: 1,
        task: { objective: 'Create result.txt', complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 },
        acceptanceCriteria: ['Start the cancellation verifier'],
        verification: [{ name: 'process tree', command: [process.execPath, processTreeVerifier, started, marker], timeoutSeconds: 10 }],
      });
      const controller = new AbortController();
      const running = scenario('success', count, () => runDurable(treeContract, assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2, signal: controller.signal }));
      for (let index = 0; index < 100; index++) {
        if (await stat(started).then(() => true, () => false)) break;
        await delay(25);
      }
      assert.equal(await stat(started).then(() => true, () => false), true);
      controller.abort();
      const result = await running;
      assert.equal(result.status, 'cancelled');
      await delay(1300);
      assert.equal(await stat(marker).then(() => true, () => false), false);
    } finally {
      await rm(count, { force: true });
      await rm(started, { force: true });
      await rm(marker, { force: true });
    }
  });
});

test('resuming a terminal run is idempotent and starts no extra worker', async () => {
  await projectFixture(async project => {
    const count = join(tmpdir(), `orqestra-count-${Date.now()}-${Math.random()}`);
    try {
      const completed = await scenario('success', count, () => runDurable(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2 }));
      const resumed = await scenario('success', count, () => resumeDurable(completed.runId, contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2 }));
      assert.equal(resumed.status, 'succeeded');
      assert.equal(resumed.attempts, 1);
      assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 1);
    } finally { await rm(count, { force: true }); }
  });
});

test('resume clears a lock whose owning process no longer exists', async () => {
  await projectFixture(async project => {
    const count = join(tmpdir(), `orqestra-count-${Date.now()}-${Math.random()}`);
    try {
      const completed = await scenario('success', count, () => runDurable(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2 }));
      await writeFile(`${completed.statePath}.lock`, JSON.stringify({ pid: 2147483647, createdAt: new Date().toISOString() }));
      const resumed = await scenario('success', count, () => resumeDurable(completed.runId, contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2 }));
      assert.equal(resumed.status, 'succeeded');
      await assert.rejects(stat(`${completed.statePath}.lock`), /ENOENT/);
      assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 1);
    } finally { await rm(count, { force: true }); }
  });
});

test('attempt exhaustion keeps useful edits and cannot report success', async () => {
  await projectFixture(async project => {
    const count = join(tmpdir(), `orqestra-count-${Date.now()}-${Math.random()}`);
    try {
      const result = await scenario('success', count, () => runDurable(contract('different'), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 1 }));
      assert.equal(result.status, 'verification-failed');
      assert.equal(result.failure?.category, 'verification');
      assert.equal(await readFile(join(project, 'result.txt'), 'utf8'), 'done\n');
      assert.notEqual(result.status, 'succeeded');
    } finally { await rm(count, { force: true }); }
  });
});

test('non-transport prerequisites fail terminally instead of creating a resumable loop', async () => {
  await projectFixture(async project => {
    const count = join(tmpdir(), `orqestra-count-${Date.now()}-${Math.random()}`);
    try {
      const result = await scenario('model-unavailable', count, () => runDurable(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, maxAttempts: 2 }));
      assert.equal(result.status, 'worker-failed');
      assert.equal(result.phase, 'terminal');
      assert.equal(result.failure?.code, 'runtime-error');
    } finally { await rm(count, { force: true }); }
  });
});

test('custom state cannot contaminate the project working tree', async () => {
  await projectFixture(async project => {
    await assert.rejects(runDurable(contract(), assignment, {
      project, executable: workerFixture, maxAttempts: 2, stateDirectory: join(project, '.orqestra-state'),
    }), /outside the project working tree/);
    assert.equal(await stat(join(project, '.orqestra-state')).then(() => true, () => false), false);
  });
});

test('CLI returns a resumable run ID and continues the matching checkpoint', async () => {
  await projectFixture(async project => {
    const count = join(tmpdir(), `orqestra-count-${Date.now()}-${Math.random()}`);
    try {
      await writeFile(join(project, 'policy.json'), JSON.stringify(createPreset()));
      await writeFile(join(project, 'execution.json'), JSON.stringify(contract()));
      git(project, 'add', 'policy.json', 'execution.json');
      git(project, 'commit', '--quiet', '-m', 'inputs');
      const args = ['--request', 'execution.json', '--project', project, '--config', 'policy.json', '--codex', workerFixture, '--turn-timeout', '5', '--json'];
      const paused = await scenario('exit-after-edit', count, async () => spawnSync(process.execPath, [cli, 'run', ...args], { cwd: project, encoding: 'utf8', timeout: 15000 }));
      assert.equal(paused.status, 1, paused.stderr);
      const first = JSON.parse(paused.stdout);
      assert.equal(first.status, 'paused');
      assert.match(first.runId, /^[a-f0-9-]+$/u);
      const resumed = await scenario('repair', count, async () => spawnSync(process.execPath, [cli, 'resume', '--run-id', first.runId, ...args], { cwd: project, encoding: 'utf8', timeout: 15000 }));
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).status, 'succeeded');
    } finally { await rm(count, { force: true }); }
  });
});
