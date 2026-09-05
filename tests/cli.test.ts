import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function invoke(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  return result;
}

async function fixture(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'orqestra-test-'));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('offline demo works without configuration, writes nothing, and reports no usage', async () => {
  await fixture(async cwd => {
    const result = invoke(cwd, 'demo', '--json');
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, 'offline-demo');
    assert.deepEqual(output.plans.map((item: { route: string }) => item.route), ['direct', 'single', 'planned', 'coordinated']);
    assert.equal(output.usage, null);
    assert.deepEqual(await readdir(cwd), []);
  });
});

test('init preserves existing files and creates a valid policy', async () => {
  await fixture(async cwd => {
    await writeFile(join(cwd, 'AGENTS.md'), 'Existing project instructions\n');
    const first = invoke(cwd, 'init', '--profile', 'economy', '--json');
    assert.equal(first.status, 0, first.stderr);
    const before = await readFile(join(cwd, 'orqestra.config.json'), 'utf8');
    const second = invoke(cwd, 'init', '--profile', 'quality', '--json');
    assert.equal(second.status, 1);
    assert.match(JSON.parse(second.stderr).error, /EEXIST/);
    assert.equal(await readFile(join(cwd, 'orqestra.config.json'), 'utf8'), before);
    assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), 'Existing project instructions\n');
    const check = invoke(cwd, 'validate', '--json');
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).availability, 'unverified');
  });
});

test('plan reads user paths with spaces and does not modify its inputs', async () => {
  await fixture(async cwd => {
    const configPath = join(cwd, 'custom policy.json');
    assert.equal(invoke(cwd, 'init', '--config', configPath).status, 0);
    const taskPath = join(cwd, 'my task.json');
    const input = JSON.stringify({ objective: 'Fix the report export', complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 });
    await writeFile(taskPath, input);
    const result = invoke(cwd, 'plan', '--config', configPath, '--task', taskPath, '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).route, 'single');
    assert.equal(await readFile(taskPath, 'utf8'), input);
    assert.equal((await readdir(cwd)).length, 2);
  });
});

test('invalid JSON and unavailable catalog models exit nonzero without a success plan', async () => {
  await fixture(async cwd => {
    await writeFile(join(cwd, 'bad.json'), '{broken');
    const invalid = invoke(cwd, 'validate', '--config', 'bad.json', '--json');
    assert.equal(invalid.status, 1);
    assert.match(JSON.parse(invalid.stderr).error, /invalid JSON/);
    assert.equal(invalid.stdout, '');
    assert.equal(invoke(cwd, 'init').status, 0);
    await writeFile(join(cwd, 'task.json'), JSON.stringify({ objective: 'Implement feature', complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 }));
    await writeFile(join(cwd, 'catalog.json'), JSON.stringify({ schemaVersion: 1, observedAt: '2026-09-05T12:00:00Z', models: [] }));
    const unavailable = invoke(cwd, 'plan', '--task', 'task.json', '--catalog', 'catalog.json', '--json');
    assert.equal(unavailable.status, 1);
    assert.match(JSON.parse(unavailable.stderr).error, /No eligible model/);
    assert.equal(unavailable.stdout, '');
  });
});

test('CLI rejects unknown commands, missing values, and flags attached to the wrong command', async () => {
  await fixture(async cwd => {
    for (const args of [['run'], ['plan'], ['init', '--profile', 'unknown'], ['demo', '--task', 'ignored.json'], ['init', '--config'], ['constructor']]) {
      const result = invoke(cwd, ...args, '--json');
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.equal(typeof JSON.parse(result.stderr).error, 'string');
    }
    assert.deepEqual(await readdir(cwd), []);
  });
});

test('doctor handles missing executables without attempting installation or sign-in', async () => {
  await fixture(async cwd => {
    const result = invoke(cwd, 'doctor', '--codex', join(cwd, 'not-installed'), '--json');
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.codex.status, 'unavailable');
    assert.equal(report.liveExecutionImplemented, true);
    assert.deepEqual(await readdir(cwd), []);
  });
});

test('human previews identify unverified availability and unchanged main model', async () => {
  await fixture(async cwd => {
    const result = invoke(cwd, 'demo', '--profile', 'quality');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PREVIEW ONLY/);
    assert.match(result.stdout, /main Codex conversation model is unchanged/);
    assert.match(result.stdout, /unverified/);
  });
});
