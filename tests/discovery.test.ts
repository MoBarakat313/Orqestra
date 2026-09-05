import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StdioClient } from '../src/runtime/stdio-client.js';
import { catalogFromDiscovery, discoverModels, readDiscovery } from '../src/runtime/discovery.js';
import { createPreset } from '../src/presets.js';
import { parseCatalog } from '../src/core/validation.js';
import { planTask } from '../src/core/router.js';

const fixturePath = fileURLToPath(new URL('./fixtures/fake-codex.js', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function fixtureClient(scenario: string, options: ConstructorParameters<typeof StdioClient>[2] = {}) {
  return new StdioClient(process.execPath, [fixturePath, scenario], { requestTimeoutMs: 2000, shutdownMs: 30, ...options });
}

test('discovery uses the handshake and read-only operations, follows pagination, and redacts account details', async () => {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const peer = {
    notify(method: string) { calls.push({ method }); },
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === 'initialize') return { userAgent: 'fixture' };
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'private@example.invalid' }, requiresOpenaiAuth: true };
      const next = (params as { cursor?: string }).cursor;
      return { data: [{ model: next ? 'next-model' : 'first-model', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: next ? null : 'next' };
    },
  };
  const result = await readDiscovery(peer, 'fixture');
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'initialized', 'account/read', 'model/list', 'model/list']);
  assert.deepEqual(calls[2]!.params, { refreshToken: false });
  assert.deepEqual(calls[4]!.params, { limit: 50, includeHidden: false, cursor: 'next' });
  assert.equal(result.models.length, 2);
  assert.equal(result.modelTurnsStarted, 0);
  assert.equal(JSON.stringify(result).includes('private@example.invalid'), false);
});

test('real subprocess transport handles JSONL chunks, notifications, and paginated discovery', async () => {
  for (const scenario of ['normal', 'split']) {
    const client = fixtureClient(scenario);
    try {
      const report = await readDiscovery(client, 'fixture');
      assert.equal(report.models.length, 2);
      assert.equal(report.account.mode, 'chatgpt');
      assert.equal(JSON.stringify(report).includes('do-not-display'), false);
    } finally { await client.close(); }
  }
});

test('portable executable preflight and discovery work through a JavaScript CLI entrypoint', async () => {
  const report = await discoverModels(fixturePath);
  assert.equal(report.codexVersion, 'codex-cli fixture');
  assert.equal(report.models[0]!.id, 'gpt-5.6-terra');
});

test('transport rejects malformed output, unknown IDs, and server action requests', async () => {
  for (const [scenario, pattern] of [
    ['malformed', /malformed JSONL/], ['unknown-id', /unknown or duplicate/], ['server-request', /unsupported by this client/],
  ] as const) {
    const client = fixtureClient(scenario);
    try { await assert.rejects(client.request('initialize', {}), pattern); }
    finally { await client.close(); }
  }
});

test('transport bounds incomplete messages and session output', async () => {
  for (const options of [{ maxMessageBytes: 100 }, { maxTotalBytes: 100 }]) {
    const client = fixtureClient('oversized', options);
    try { await assert.rejects(client.request('initialize', {}), /byte limit/); }
    finally { await client.close(); }
  }
});

test('process exit, spawn failure, and timeout reject pending requests without exposing backend details', async () => {
  for (const [scenario, pattern] of [['exit', /exited/], ['hang', /timed out/], ['error', /RPC code -32001/]] as const) {
    const client = fixtureClient(scenario, { requestTimeoutMs: 350 });
    try {
      await assert.rejects(client.request('initialize', {}), error => {
        assert.match(String(error), pattern);
        assert.equal(String(error).includes('secret-auth-value'), false);
        return true;
      });
    } finally { await client.close(); }
  }
  const client = new StdioClient(join(tmpdir(), 'orqestra-missing-executable'), [], { shutdownMs: 30 });
  try { await assert.rejects(client.request('initialize', {}), /Could not start/); }
  finally { await client.close(); }
});

test('closing is idempotent and rejects pending requests even if the process ignores graceful shutdown', async () => {
  const client = fixtureClient('stubborn');
  const pending = assert.rejects(client.request('initialize', {}), /connection closed/);
  await client.close();
  await pending;
  await client.close();
  await assert.rejects(client.request('model/list', {}), /connection closed/);
});

function responsesPeer(pages: unknown[], account: unknown = { account: null, requiresOpenaiAuth: true }) {
  let index = 0;
  return {
    notify(_method: string) {},
    async request(method: string, _params: unknown) {
      if (method === 'initialize') return {};
      if (method === 'account/read') return account;
      return pages[Math.min(index++, pages.length - 1)];
    },
  };
}

test('discovery rejects corrupt pages and pagination loops instead of hanging or inventing access', async () => {
  await assert.rejects(readDiscovery(responsesPeer([{ data: [], nextCursor: 'repeat' }]), 'fixture'), /repeated pagination/);
  await assert.rejects(readDiscovery(responsesPeer([{ data: [], nextCursor: 5 }]), 'fixture'), /pagination cursor/);
  await assert.rejects(readDiscovery(responsesPeer([{ data: 'invalid', nextCursor: null }]), 'fixture'), /Invalid model\/list data/);
  await assert.rejects(readDiscovery(responsesPeer([{ data: [{ model: 'x', displayName: 'X' }], nextCursor: null }]), 'fixture'), /missing supported reasoning/);
  await assert.rejects(readDiscovery(responsesPeer([], { account: {} }), 'fixture'), /requiresOpenaiAuth/);
});

test('discovery hides hidden entries, warns when unauthenticated, and rejects duplicate identities', async () => {
  const row = { model: 'x', displayName: 'X', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] };
  const result = await readDiscovery(responsesPeer([{ data: [{ hidden: true }, row], nextCursor: null }]), 'fixture');
  assert.equal(result.models.length, 1);
  assert.equal(result.account.mode, 'none');
  assert(result.warnings.some(warning => warning.includes('No signed-in')));
  await assert.rejects(readDiscovery(responsesPeer([{ data: [row, row], nextCursor: null }]), 'fixture'), /duplicate model/);
});

test('catalog export intersects configured models/settings and marks capability provenance', async () => {
  const config = createPreset();
  const report = await discoverModels(fixturePath);
  const catalog = catalogFromDiscovery(report, config);
  assert.equal(catalog.capabilitiesSource, 'configuration');
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(catalog.models[0]!.reasoningEfforts, ['medium']);
  const result = planTask(config, { objective: 'Do work', complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 }, catalog);
  assert(result.warnings.some(warning => warning.includes('role capabilities come from configuration')));
});

test('models CLI exports a reusable catalog without overwriting files or leaking account details', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orqestra-discovery-test-'));
  try {
    await writeFile(join(cwd, 'policy.json'), JSON.stringify(createPreset()));
    const args = [cli, 'models', '--codex', fixturePath, '--config', 'policy.json', '--output', 'catalog.json', '--json'];
    const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.modelTurnsStarted, 0);
    assert.equal(result.stdout.includes('private@example.invalid'), false);
    const before = await readFile(join(cwd, 'catalog.json'), 'utf8');
    assert.equal(parseCatalog(JSON.parse(before)).capabilitiesSource, 'configuration');
    const repeated = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 15000 });
    assert.equal(repeated.status, 1);
    assert.match(JSON.parse(repeated.stderr).error, /EEXIST/);
    assert.equal(await readFile(join(cwd, 'catalog.json'), 'utf8'), before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
