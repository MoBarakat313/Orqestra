import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBenchmarkRunSpec } from '../src/core/benchmark-run.js';
import { createPreset } from '../src/presets.js';
import { runAutomatedBenchmark } from '../src/runtime/benchmark-runner.js';

const codexFixture = fileURLToPath(new URL('./fixtures/fake-worker-codex.js', import.meta.url));
const verifier = fileURLToPath(new URL('./fixtures/verify-file.js', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function projectFixture(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'orqestra-benchmark-runner-test-'));
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

function specification(repetitions = 2) {
  return parseBenchmarkRunSpec({
    schemaVersion: 1,
    benchmarkId: 'fixture-benchmark',
    taskId: 'create-result',
    repetitions,
    order: 'alternating',
    preparation: [],
    execution: {
      schemaVersion: 1,
      task: { objective: 'Create result.txt', complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 },
      acceptanceCriteria: ['result.txt contains done'],
      verification: [{ name: 'result content', command: [process.execPath, verifier, 'result.txt', 'done'], timeoutSeconds: 10 }],
    },
    direct: { model: null, reasoning: null },
  });
}

async function scenario<T>(name: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ORQESTRA_WORKER_SCENARIO;
  process.env.ORQESTRA_WORKER_SCENARIO = name;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.ORQESTRA_WORKER_SCENARIO;
    else process.env.ORQESTRA_WORKER_SCENARIO = previous;
  }
}

test('automated runner creates isolated pairs, alternates order, and records private measured evidence', async () => {
  await projectFixture(async project => {
    const report = await runAutomatedBenchmark(specification(), createPreset(), { project, executable: codexFixture, timeoutSeconds: 5 });
    assert.equal(report.benchmark.trials.executedPairs, 2);
    assert.deepEqual(report.trials.map(trial => trial.order), [['direct-codex', 'orqestra'], ['orqestra', 'direct-codex']]);
    assert.equal(report.comparison.matchedModel, true);
    assert.equal(report.benchmark.completion.directSucceeded, 2);
    assert.equal(report.benchmark.completion.orqestraSucceeded, 2);
    assert.equal(report.benchmark.tokens?.direct.totalTokens, 200);
    assert.equal(report.benchmark.tokens?.orqestra.totalTokens, 240);
    assert.equal(report.benchmark.tokens?.difference.totalTokens, 40);
    assert.deepEqual(report.benchmark.models.direct.map(row => [row.model, row.turns, row.measuredTurns]), [['gpt-5.6-terra', 2, 2]]);
    assert.deepEqual(report.benchmark.models.orqestra.map(row => [row.model, row.turns, row.measuredTurns]), [['gpt-5.6-terra', 2, 2]]);
    assert.equal(git(project, 'status', '--porcelain'), '');
    assert.equal(await stat(report.artifacts.ledger).then(info => info.isFile()), true);
    const saved = await readFile(report.artifacts.report, 'utf8');
    assert.equal(saved.includes('private direct fixture response'), false);
    assert.equal(saved.includes('Create result.txt'), false);
    assert.match(report.contractSha256, /^[a-f0-9]{64}$/u);
    assert.match(report.policySha256, /^[a-f0-9]{64}$/u);
    for (const trial of report.trials) {
      assert.notEqual(trial.evidence.direct.worktree, trial.evidence.orqestra.worktree);
      assert.equal(await readFile(join(trial.evidence.direct.worktree, 'result.txt'), 'utf8'), 'done\n');
      assert.equal(await readFile(join(trial.evidence.orqestra.worktree, 'result.txt'), 'utf8'), 'done\n');
      assert.match(trial.evidence.direct.eventEvidence[0]!.sha256, /^[a-f0-9]{64}$/u);
    }
  });
});

test('benchmark run specification rejects mismatched direct model settings and unsafe repetition counts', () => {
  const base = JSON.parse(JSON.stringify(specification())) as Record<string, unknown>;
  assert.throws(() => parseBenchmarkRunSpec({ ...base, repetitions: 0 }), /between 1 and 20/);
  assert.throws(() => parseBenchmarkRunSpec({ ...base, direct: { model: 'gpt-example', reasoning: null } }), /must both be null or both be strings/);
  assert.throws(() => parseBenchmarkRunSpec({ ...base, taskId: '../unsafe' }), /lowercase letters/);
});

test('automated runner rejects a dirty source before creating a Codex turn', async () => {
  await projectFixture(async project => {
    await writeFile(join(project, 'local.txt'), 'preserve\n');
    await assert.rejects(runAutomatedBenchmark(specification(1), createPreset(), { project, executable: codexFixture }), /clean Git working tree/);
    assert.equal(await readFile(join(project, 'local.txt'), 'utf8'), 'preserve\n');
  });
});

test('automated runner excludes a pair when direct token telemetry is incomplete', async () => {
  await projectFixture(async project => {
    const report = await scenario('direct-missing-usage', () =>
      runAutomatedBenchmark(specification(1), createPreset(), { project, executable: codexFixture, timeoutSeconds: 5 }));
    assert.equal(report.benchmark.trials.executedPairs, 1);
    assert.equal(report.benchmark.trials.tokenMeasuredPairs, 0);
    assert.equal(report.benchmark.tokens, null);
    assert.equal(report.trials[0]!.direct.usage.models[0]!.measuredTurns, 0);
    assert(report.trials[0]!.evidence.direct.warnings.some(warning => warning.includes('lacked final usage telemetry')));
  });
});

test('automated runner cannot report direct success after a nonzero Codex exit', async () => {
  await projectFixture(async project => {
    const report = await scenario('direct-nonzero-after-complete', () =>
      runAutomatedBenchmark(specification(1), createPreset(), { project, executable: codexFixture, timeoutSeconds: 5 }));
    assert.equal(report.trials[0]!.direct.status, 'failed');
    assert.equal(report.benchmark.completion.directSucceeded, 0);
    assert.equal(report.benchmark.completion.orqestraSucceeded, 1);
  });
});

test('benchmark-run CLI emits the completed paired report', async () => {
  await projectFixture(async project => {
    await writeFile(join(project, 'policy.json'), JSON.stringify(createPreset()));
    await writeFile(join(project, 'benchmark-run.json'), JSON.stringify(specification(1)));
    git(project, 'add', 'policy.json', 'benchmark-run.json');
    git(project, 'commit', '--quiet', '-m', 'benchmark inputs');
    const result = spawnSync(process.execPath, [cli, 'benchmark-run', '--input', 'benchmark-run.json', '--project', project, '--config', 'policy.json', '--codex', codexFixture, '--turn-timeout', '5', '--json'], {
      cwd: project, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'automated-benchmark-run');
    assert.equal(report.benchmark.trials.executedPairs, 1);
    assert.equal(report.comparison.matchedModel, true);
  });
});
