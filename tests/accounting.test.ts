import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAccountUsage } from '../src/runtime/accounting.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.js', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('ChatGPT account report keeps account-wide windows separate from worker usage', async () => {
  const methods: string[] = [];
  const peer = {
    notify(method: string) { methods.push(method); },
    async request(method: string, _params: unknown) {
      methods.push(method);
      if (method === 'initialize') return {};
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'private@example.invalid' }, requiresOpenaiAuth: true };
      if (method === 'account/rateLimits/read') return { rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1780000000 }, secondary: null } };
      return { summary: { lifetimeTokens: 1000, peakDailyTokens: null, longestRunningTurnSec: 10, currentStreakDays: 2, longestStreakDays: 4 }, dailyUsageBuckets: null };
    },
  };
  const report = await readAccountUsage(peer, 'fixture');
  assert.equal(report.status, 'available');
  assert.equal(report.billingMode, 'chatgpt-account');
  assert.equal(report.chatgpt?.rateLimits?.[0]?.primary?.usedPercent, 20);
  assert.equal(report.chatgpt?.tokenActivity?.lifetimeTokens, 1000);
  assert.equal(JSON.stringify(report).includes('private@example.invalid'), false);
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/usage/read']);
});

test('API-key report never requests ChatGPT account endpoints or invents API cost', async () => {
  const methods: string[] = [];
  const report = await readAccountUsage({
    notify(method: string) { methods.push(method); },
    async request(method: string, _params: unknown) {
      methods.push(method);
      if (method === 'initialize') return {};
      return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
    },
  }, 'fixture');
  assert.equal(report.billingMode, 'api');
  assert.equal(report.api?.cost, null);
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/read']);
});

test('usage CLI returns bounded account observations and starts no model turn', () => {
  const result = spawnSync(process.execPath, [cli, 'usage', '--codex', fixture, '--json'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'account-usage');
  assert.equal(report.modelTurnsStarted, 0);
  assert.equal(report.chatgpt.rateLimits[0].primary.usedPercent, 25);
  assert.equal(result.stdout.includes('private@example.invalid'), false);
});

