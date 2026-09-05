import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeTurnUsage, combineUsageSummaries, parseTurnUsageNotification, summarizeUsage, unavailableTurnUsage } from '../src/core/usage.js';

const notification = {
  threadId: 'thread-1', turnId: 'turn-1',
  tokenUsage: {
    last: { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 5, outputTokens: 20, reasoningOutputTokens: 8, totalTokens: 120 },
    total: { inputTokens: 300, cachedInputTokens: 180, cacheWriteInputTokens: 10, outputTokens: 70, reasoningOutputTokens: 25, totalTokens: 370 },
    modelContextWindow: 200000,
  },
};

test('token usage parses the matching turn and keeps diagnostic categories separate', () => {
  const usage = parseTurnUsageNotification(notification, 'chatgpt', 'thread-1', 'turn-1');
  assert.equal(usage?.tokens?.totalTokens, 120);
  assert.equal(usage?.threadTotal?.totalTokens, 370);
  assert.equal(usage?.tokens?.reasoningOutputTokens, 8);
  assert.equal(usage?.billingMode, 'chatgpt-account');
  assert.equal(parseTurnUsageNotification(notification, 'chatgpt', 'other', 'turn-1'), null);
});

test('resumed turns use a cumulative before-and-after delta', () => {
  const final = parseTurnUsageNotification(notification, 'chatgpt', 'thread-1', 'turn-1')!;
  const attributed = attributeTurnUsage(final, { inputTokens: 200, cachedInputTokens: 120, cacheWriteInputTokens: 5, outputTokens: 50, reasoningOutputTokens: 17, totalTokens: 250 }, false);
  assert.deepEqual(attributed.tokens, { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 5, outputTokens: 20, reasoningOutputTokens: 8, totalTokens: 120 });
  const missing = attributeTurnUsage(final, null, false);
  assert.equal(missing.tokens?.totalTokens, 120);
  assert(missing.gaps.some(gap => gap.includes('may omit continuations')));
});

test('usage rejects impossible categories instead of silently repairing them', () => {
  const bad = structuredClone(notification);
  bad.tokenUsage.last.cachedInputTokens = 101;
  assert.throws(() => parseTurnUsageNotification(bad, 'chatgpt', 'thread-1', 'turn-1'), /cannot exceed/);
});

test('aggregation sums attempt-local usage and preserves partial visibility', () => {
  const measured = summarizeUsage('worker-turn', [parseTurnUsageNotification(notification, 'apiKey', 'thread-1', 'turn-1')!]);
  const missing = summarizeUsage('worker-turn', [unavailableTurnUsage('apiKey', 'fixture telemetry gap')]);
  const report = combineUsageSummaries('durable-run', [measured, missing]);
  assert.deepEqual(report.attempts, { total: 2, measured: 1, unmeasured: 1 });
  assert.equal(report.tokens?.totalTokens, 120);
  assert.equal(report.billingMode, 'api');
  assert.equal(report.cost.status, 'unavailable');
  assert(report.gaps.some(gap => gap.includes('1 of 2')));
});
