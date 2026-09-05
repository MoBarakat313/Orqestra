import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExecutionContract } from '../src/core/execution.js';
import { createPreset } from '../src/presets.js';
import { runWorker, type ApprovalRequest } from '../src/runtime/worker.js';

const workerFixture = fileURLToPath(new URL('./fixtures/fake-worker-codex.js', import.meta.url));
const verifier = fileURLToPath(new URL('./fixtures/verify-file.js', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const assignment = { role: 'implement' as const, alias: 'balanced', id: 'gpt-5.6-terra', runtime: 'codex', reasoning: 'medium', group: 'standard' as const, reason: 'fixture' };

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function projectFixture(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'orqestra-worker-test-'));
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
    task: { objective: 'Create result.txt', complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 },
    acceptanceCriteria: ['result.txt contains the expected text'],
    verification: [{ name: 'result content', command: [process.execPath, verifier, 'result.txt', expected], timeoutSeconds: 10 }],
  });
}

async function scenario<T>(name: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.ORQESTRA_WORKER_SCENARIO;
  process.env.ORQESTRA_WORKER_SCENARIO = name;
  try { return await run(); }
  finally {
    if (before === undefined) delete process.env.ORQESTRA_WORKER_SCENARIO;
    else process.env.ORQESTRA_WORKER_SCENARIO = before;
  }
}

test('one worker change succeeds only after independent verification passes', async () => {
  await projectFixture(async project => {
    const report = await scenario('success', () => runWorker(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5 }));
    assert.equal(report.status, 'succeeded');
    assert.equal(report.attempts, 1);
    assert.equal(report.verification[0]!.status, 'passed');
    assert.deepEqual(report.changes.changedFiles, ['result.txt']);
    assert.match(report.changes.evidenceSha256!, /^[a-f0-9]{64}$/u);
    assert(report.changes.evidenceBytes > Buffer.byteLength('?? result.txt\0'));
    assert.equal(await readFile(join(project, 'result.txt'), 'utf8'), 'done\n');
    assert.equal(report.usage, null);
  });
});

test('failed verification cannot produce a successful worker report', async () => {
  await projectFixture(async project => {
    const report = await scenario('success', () => runWorker(contract('different'), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5 }));
    assert.equal(report.status, 'verification-failed');
    assert.equal(report.verification[0]!.status, 'failed');
    assert.notEqual(report.status, 'succeeded');
  });
});

test('rename evidence includes both the source and destination paths', async () => {
  await projectFixture(async project => {
    const report = await scenario('rename', () => runWorker(contract('fixture'), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5 }));
    assert.equal(report.status, 'succeeded');
    assert.deepEqual([...report.changes.changedFiles].sort(), ['README.md', 'result.txt']);
  });
});

test('worker failures expose only a bounded error category and status code', async () => {
  await projectFixture(async project => {
    const report = await scenario('failure', () => runWorker(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5 }));
    assert.equal(report.status, 'worker-failed');
    assert.deepEqual(report.workerError, { category: 'httpConnectionFailed', httpStatusCode: 503 });
    assert.equal(JSON.stringify(report).includes('private fixture failure'), false);
  });
});

test('approval requests are scoped, forwarded to the handler, and never granted by default', async () => {
  await projectFixture(async project => {
    const seen: ApprovalRequest[] = [];
    const report = await scenario('approval', () => runWorker(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, approvalHandler(request) { seen.push(request); return 'cancel'; } }));
    assert.equal(report.status, 'approval-required');
    assert.equal(report.workerTurnStatus, 'interrupted');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.threadId, report.threadId);
    assert.equal(seen[0]!.turnId, report.turnId);
    assert.equal(report.verification.length, 0);
  });
});

test('the worker API defaults every approval request to cancel', async () => {
  await projectFixture(async project => {
    const report = await scenario('approval', () => runWorker(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5 }));
    assert.equal(report.status, 'approval-required');
    assert.equal(report.approvals.length, 1);
    assert.equal(report.verification.length, 0);
  });
});

test('abort signals interrupt the active turn and produce a cancelled report', async () => {
  await projectFixture(async project => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const report = await scenario('hang', () => runWorker(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5, signal: controller.signal }));
    assert.equal(report.status, 'cancelled');
    assert.equal(report.workerTurnStatus, 'interrupted');
    assert.equal(report.verification.length, 0);
  });
});

test('App Server exit after turn acknowledgement fails immediately', async () => {
  await projectFixture(async project => {
    const started = Date.now();
    await assert.rejects(scenario('exit-after-start', () => runWorker(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5 })), /exited/);
    assert(Date.now() - started < 2000);
  });
});

test('App Server exit during discovery rejects without an unhandled completion', async () => {
  await projectFixture(async project => {
    await assert.rejects(scenario('exit-during-discovery', () => runWorker(contract(), assignment, { project, executable: workerFixture, turnTimeoutSeconds: 5 })), /exited/);
  });
});

test('a dirty project is rejected before a model turn can start', async () => {
  await projectFixture(async project => {
    await writeFile(join(project, 'local.txt'), 'preserve\n');
    await assert.rejects(runWorker(contract(), assignment, { project, executable: workerFixture }), /clean Git working tree/);
    assert.equal(await readFile(join(project, 'local.txt'), 'utf8'), 'preserve\n');
  });
});

test('run CLI selects the configured implementer and returns nonzero on verification failure', async () => {
  await projectFixture(async project => {
    await writeFile(join(project, 'policy.json'), JSON.stringify(createPreset()));
    await writeFile(join(project, 'execution.json'), JSON.stringify(contract('different')));
    git(project, 'add', 'policy.json', 'execution.json');
    git(project, 'commit', '--quiet', '-m', 'contract');
    const result = await scenario('success', async () => spawnSync(process.execPath, [cli, 'run', '--request', 'execution.json', '--project', project, '--config', 'policy.json', '--codex', workerFixture, '--turn-timeout', '5', '--json'], { cwd: project, encoding: 'utf8', timeout: 15000 }));
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'verification-failed');
    assert.equal(result.stderr, '');
  });
});

test('execution contracts reject shell strings, missing checks, and oversized limits', () => {
  const base = JSON.parse(JSON.stringify(contract())) as Record<string, unknown>;
  assert.throws(() => parseExecutionContract({ ...base, verification: [] }), /1 to 10/);
  assert.throws(() => parseExecutionContract({ ...base, verification: [{ name: 'x', command: 'npm test', timeoutSeconds: 10 }] }), /1 to 32 arguments/);
  assert.throws(() => parseExecutionContract({ ...base, verification: [{ name: 'x', command: ['npm', 'test'], timeoutSeconds: 1000 }] }), /between 1 and 600/);
});
