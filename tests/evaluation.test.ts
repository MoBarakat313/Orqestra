import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateBenchmark, parseBenchmark } from '../src/core/evaluation.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const tokens = { inputTokens: 100, cachedInputTokens: 50, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 };
const observation = (source: 'direct-codex' | 'orqestra', totalTokens: number, retries: number) => ({
  source, observedAt: '2026-09-06T10:00:00Z', status: 'succeeded', verification: { passed: 2, total: 2 }, regressions: 0, retries, elapsedMs: source === 'direct-codex' ? 1000 : 800,
  usage: { accountMode: 'chatgpt', tokens: { ...tokens, totalTokens }, apiCostUsd: null },
});

function input() {
  return {
    schemaVersion: 1, benchmarkId: 'fixture-benchmark', trials: [
      { id: 'one', taskId: 'task-a', contractSha256: 'a'.repeat(64), baseCommit: 'b'.repeat(40), direct: observation('direct-codex', 150, 1), orqestra: observation('orqestra', 120, 0) },
      { id: 'two', taskId: 'task-a', contractSha256: 'a'.repeat(64), baseCommit: 'b'.repeat(40), direct: observation('direct-codex', 160, 0), orqestra: null },
    ],
  };
}

test('benchmark reports quality and paired differences from executed pairs only', () => {
  const report = evaluateBenchmark(parseBenchmark(input()));
  assert.deepEqual(report.trials, { total: 2, executedPairs: 1, incompletePairs: 1, tokenMeasuredPairs: 1, apiCostMeasuredPairs: 0 });
  assert.equal(report.completion.directSucceeded, 1);
  assert.equal(report.verification.orqestraPassed, 2);
  assert.deepEqual(report.retries, { direct: 1, orqestra: 0 });
  assert.equal(report.tokens?.difference.totalTokens, -30);
  assert.equal(report.apiCostUsd, null);
  assert(report.warnings.some(warning => warning.includes('No unexecuted counterfactual')));
});

test('benchmark rejects changed starting conditions and mislabeled arms', () => {
  const changed = input();
  changed.trials[1]!.baseCommit = 'c'.repeat(40);
  assert.throws(() => parseBenchmark(changed), /one reproducible contract and base commit/);
  const mislabeled = input();
  mislabeled.trials[0]!.direct!.source = 'orqestra';
  assert.throws(() => parseBenchmark(mislabeled), /source must be direct-codex/);
});

test('unexecuted and unmeasured arms never produce token or cost differences', () => {
  const onlyIncomplete = input();
  onlyIncomplete.trials = [onlyIncomplete.trials[1]!];
  const report = evaluateBenchmark(parseBenchmark(onlyIncomplete));
  assert.equal(report.trials.executedPairs, 0);
  assert.equal(report.tokens, null);
  assert.equal(report.apiCostUsd, null);
});

test('benchmark CLI emits the same strict measured-pair report', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orqestra-benchmark-test-'));
  try {
    await writeFile(join(cwd, 'benchmark.json'), JSON.stringify(input()));
    const result = spawnSync(process.execPath, [cli, 'benchmark', '--input', 'benchmark.json', '--json'], { cwd, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'benchmark-evaluation');
    assert.equal(report.trials.executedPairs, 1);
    assert.equal(report.tokens.difference.totalTokens, -30);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('schema 2 reports per-model coverage and excludes partial token pairs', () => {
  const direct = observation('direct-codex', 150, 0);
  const orqestra = observation('orqestra', 120, 0);
  const withModels = {
    schemaVersion: 2,
    benchmarkId: 'model-coverage',
    trials: [{
      id: 'one', taskId: 'task-a', contractSha256: 'a'.repeat(64), baseCommit: 'b'.repeat(40),
      direct: { ...direct, usage: { ...direct.usage, models: [{ model: 'gpt-direct', reasoning: 'medium', turns: 1, measuredTurns: 1, tokens: direct.usage.tokens }] } },
      orqestra: { ...orqestra, usage: { ...orqestra.usage, models: [{ model: 'gpt-worker', reasoning: 'medium', turns: 2, measuredTurns: 1, tokens: orqestra.usage.tokens }] } },
    }],
  };
  const report = evaluateBenchmark(parseBenchmark(withModels));
  assert.equal(report.trials.executedPairs, 1);
  assert.equal(report.trials.tokenMeasuredPairs, 0);
  assert.equal(report.tokens, null);
  assert.deepEqual(report.models.orqestra.map(row => [row.model, row.turns, row.measuredTurns]), [['gpt-worker', 2, 1]]);
});

test('schema 2 rejects token totals that do not equal their per-model rows', () => {
  const direct = observation('direct-codex', 150, 0);
  const mismatched = {
    schemaVersion: 2,
    benchmarkId: 'mismatched-model-total',
    trials: [{
      id: 'one', taskId: 'task-a', contractSha256: 'a'.repeat(64), baseCommit: 'b'.repeat(40),
      direct: { ...direct, usage: { ...direct.usage, models: [{ model: 'gpt-direct', reasoning: 'medium', turns: 1, measuredTurns: 1, tokens: { ...direct.usage.tokens, totalTokens: 149 } }] } },
      orqestra: null,
    }],
  };
  assert.throws(() => parseBenchmark(mismatched), /must equal the measured per-model token sum/);
});
