import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreset } from '../src/presets.js';
import { parseCatalog, parseConfig, parseTask } from '../src/core/validation.js';
import { planTask, selectModel } from '../src/core/router.js';
import { advertisesAppServer } from '../src/runtime/doctor.js';
import type { Catalog, Config, TaskAssessment } from '../src/core/types.js';

function task(overrides: Partial<TaskAssessment> = {}): TaskAssessment {
  return parseTask({ objective: 'Implement the requested change', complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1, ...overrides });
}

function catalog(config: Config): Catalog {
  return parseCatalog({
    schemaVersion: 1, observedAt: '2026-09-05T12:00:00Z',
    models: Object.values(config.models).map(({ id, runtime, reasoningEfforts, capabilities }) => ({ id, runtime, reasoningEfforts, capabilities })),
  });
}

test('all presets validate and independently own their mutable state', () => {
  for (const profile of ['economy', 'balanced', 'quality'] as const) {
    assert.equal(parseConfig(createPreset(profile)).profile, profile);
  }
  const modified = createPreset();
  modified.models.balanced!.reasoningEfforts.push('invented');
  assert.equal(createPreset().models.balanced!.reasoningEfforts.includes('invented'), false);
});

test('direct route keeps the current session and needs no worker availability', () => {
  const config = parseConfig(createPreset('quality'));
  const observed = catalog(config);
  observed.models = [];
  const result = planTask(config, task({ complexity: 'small' }), observed);
  assert.equal(result.route, 'direct');
  assert.deepEqual(result.assignments, []);
  assert.equal(result.parallelWorkers, 0);
  assert.equal(result.usage, null);
});

test('ordinary feature uses one implementer without automatic explorer or reviewer overhead', () => {
  const result = planTask(parseConfig(createPreset()), task());
  assert.equal(result.route, 'single');
  assert.deepEqual(result.assignments.map(item => item.role), ['implement']);
  assert.equal(result.assignments[0]!.id, 'gpt-5.6-terra');
  assert.equal(result.availability, 'unverified');
});

test('small high-risk work cannot take the direct fast path', () => {
  const result = planTask(parseConfig(createPreset()), task({ complexity: 'small', risk: 'high' }));
  assert.equal(result.route, 'planned');
  assert.equal(result.verification, 'critical-review');
  assert.deepEqual(result.assignments.map(item => item.role), ['plan', 'implement', 'review']);
});

test('unclear scope calls for planning and review even when the task is small', () => {
  const result = planTask(parseConfig(createPreset()), task({ complexity: 'small', ambiguity: 'unclear' }));
  assert.equal(result.route, 'planned');
  assert.equal(result.verification, 'targeted-review');
  assert(result.warnings.some(message => message.includes('resolve unclear')));
});

test('concurrency requires independent packages and is bounded by configured capacity', () => {
  const config = parseConfig(createPreset());
  const result = planTask(config, task({ complexity: 'complex', independentPackages: 4 }));
  assert.equal(result.route, 'coordinated');
  assert.equal(result.parallelWorkers, 2);
  assert.equal(result.packageCount, 4);
  config.limits.maxWorkers = 1;
  const serial = planTask(config, task({ independentPackages: 4 }));
  assert.equal(serial.route, 'planned');
  assert.equal(serial.parallelWorkers, 1);
});

test('premium capacity limits premium implementation, not just total workers', () => {
  const config = parseConfig(createPreset('quality'));
  const result = planTask(config, task({ independentPackages: 4 }));
  assert.equal(result.parallelWorkers, 1);
  assert.equal(result.route, 'planned');
});

test('disabled premium workers select only an explicitly configured eligible fallback', () => {
  const config = createPreset();
  config.limits.maxPremiumWorkers = 0;
  assert.throws(() => selectModel(parseConfig(config), 'plan'), /premium workers disabled/);
  config.roles.plan.push({ model: 'balanced', reasoning: 'medium' });
  assert.equal(selectModel(parseConfig(config), 'plan').alias, 'balanced');
});

test('recorded catalog filters model availability and reports the chosen fallback', () => {
  const config = parseConfig(createPreset('economy'));
  const observed = catalog(config);
  observed.models = observed.models.filter(model => model.id !== config.models.economical!.id);
  const result = planTask(config, task(), observed);
  assert.equal(result.assignments[0]!.alias, 'balanced');
  assert.match(result.assignments[0]!.reason, /fallback/);
  assert.equal(result.availability, 'recorded-catalog');
  assert.equal(result.catalogObservedAt, observed.observedAt);
});

test('catalog filters unsupported reasoning and capabilities, with no implicit substitution', () => {
  const config = parseConfig(createPreset());
  const observed = catalog(config);
  const selected = observed.models.find(model => model.id === config.models.balanced!.id)!;
  selected.reasoningEfforts = ['low'];
  assert.throws(() => planTask(config, task(), observed), /No eligible model for implement/);
  selected.reasoningEfforts = ['medium'];
  selected.capabilities = ['read'];
  assert.throws(() => planTask(config, task(), observed), /No eligible model for implement/);
});

test('the same model ID under another runtime is not a billing fallback', () => {
  const config = parseConfig(createPreset());
  const observed = catalog(config);
  observed.models.forEach(model => { model.runtime = 'other-runtime'; });
  assert.throws(() => planTask(config, task(), observed), /no automatic model or billing substitution/);
});

test('future model IDs and reasoning settings require only validated policy/catalog data', () => {
  const config = createPreset();
  config.profile = 'custom';
  config.models.next = { id: 'future-model-example', runtime: 'future-runtime', group: 'standard', reasoningEfforts: ['adaptive'], capabilities: ['code'] };
  config.roles.implement = [{ model: 'next', reasoning: 'adaptive' }];
  const valid = parseConfig(config);
  const result = planTask(valid, task(), catalog(valid));
  assert.equal(result.assignments[0]!.id, 'future-model-example');
  assert.equal(result.assignments[0]!.reasoning, 'adaptive');
});

test('configuration rejects unknown schema and misspelled fields', () => {
  assert.throws(() => parseConfig({ ...createPreset(), schemaVersion: 2 }), /unsupported schema/);
  assert.throws(() => parseConfig({ ...createPreset(), maxWorker: 3 }), /unknown fields/);
  const config = createPreset();
  Object.assign(config.models.balanced!, { pricee: 1 });
  assert.throws(() => parseConfig(config), /unknown fields/);
});

test('invalid limits cannot slip through as coercible or unbounded values', () => {
  for (const maxWorkers of [0, -1, 1.5, 17, NaN, Infinity, '2', true]) {
    assert.throws(() => parseConfig({ ...createPreset(), limits: { maxWorkers, maxPremiumWorkers: 0, maxAttempts: 2 } }), /maxWorkers/);
  }
  const config = createPreset();
  config.limits.maxPremiumWorkers = 3;
  assert.throws(() => parseConfig(config), /maxPremiumWorkers/);
  config.limits.maxPremiumWorkers = 1;
  config.limits.maxAttempts = 0;
  assert.throws(() => parseConfig(config), /maxAttempts/);
});

test('model references, reasoning declarations, and role capabilities are validated', () => {
  const config = createPreset();
  config.roles.implement = [{ model: 'missing', reasoning: 'medium' }];
  assert.throws(() => parseConfig(config), /unknown model/);
  config.roles.implement = [{ model: 'advanced', reasoning: 'none' }];
  assert.throws(() => parseConfig(config), /does not declare reasoning/);
  config.models.balanced!.capabilities = ['read'];
  config.roles.implement = [{ model: 'balanced', reasoning: 'medium' }];
  assert.throws(() => parseConfig(config), /lacks code capability/);
});

test('duplicate candidates and runtime identities fail validation', () => {
  const config = createPreset();
  config.roles.implement.push({ ...config.roles.implement[0]! });
  assert.throws(() => parseConfig(config), /duplicate candidate/);
  config.roles.implement.pop();
  config.models.duplicate = { ...config.models.balanced! };
  assert.throws(() => parseConfig(config), /Duplicate runtime\/model/);
});

test('prototype-like aliases and control characters cannot affect output or lookup', () => {
  const config = createPreset();
  Object.defineProperty(config.models, 'constructor', { value: config.models.balanced!, enumerable: true });
  assert.throws(() => parseConfig(config), /Invalid model alias/);
  assert.throws(() => task({ objective: '\u001b[2Jhide' }), /control characters/);
  assert.throws(() => task({ objective: '   ' }), /nonempty/);
});

test('task assessment requires explicit valid evidence fields', () => {
  assert.throws(() => parseTask({ objective: 'Do something' }), /missing fields/);
  assert.throws(() => task({ independentPackages: 0 }), /independentPackages/);
  assert.throws(() => parseTask({ ...task(), risk: 'maybe' }), /risk must be/);
});

test('catalog validation preserves empty observations and rejects corrupt entries', () => {
  assert.deepEqual(parseCatalog({ schemaVersion: 1, observedAt: '2026-09-05T12:00:00Z', models: [] }).models, []);
  const observed = catalog(createPreset());
  observed.models.push(observed.models[0]!);
  assert.throws(() => parseCatalog(observed), /Duplicate catalog/);
  assert.throws(() => parseCatalog({ ...observed, observedAt: 'yesterday' }), /UTC ISO/);
});

test('doctor does not mistake generic root help or incidental prose for a supported command', () => {
  assert.equal(advertisesAppServer('Commands:\n  exec  Run a command\n  login Sign in\n'), false);
  assert.equal(advertisesAppServer('Consider using app-server in a future release'), false);
  assert.equal(advertisesAppServer('Commands:\n  app-server  Run the app server\n'), true);
});
