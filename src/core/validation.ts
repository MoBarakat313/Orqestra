import { ROLES, ROLE_CAPABILITY, type Candidate, type Capability, type Catalog, type Config, type ModelDeclaration, type TaskAssessment } from './types.js';

export class InputError extends Error {
  override name = 'InputError';
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown, path: string, keys?: readonly string[]): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError(`${path} must be an object`);
  }
  const result = value as ObjectValue;
  if (keys) {
    const extra = Object.keys(result).filter(key => !keys.includes(key));
    const missing = keys.filter(key => !Object.hasOwn(result, key));
    if (extra.length || missing.length) {
      throw new InputError(`${path}: unknown fields [${extra.join(', ')}]; missing fields [${missing.join(', ')}]`);
    }
  }
  return result;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new InputError(`${path} must be a nonempty string without control characters`);
  }
  return value;
}

function choice<T extends string>(value: unknown, path: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new InputError(`${path} must be one of: ${choices.join(', ')}`);
  }
  return value as T;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new InputError(`${path} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function array(value: unknown, path: string, nonempty = true): unknown[] {
  if (!Array.isArray(value) || (nonempty && !value.length)) {
    throw new InputError(`${path} must be ${nonempty ? 'a nonempty' : 'an'} array`);
  }
  return value;
}

function strings(value: unknown, path: string): string[] {
  const result = array(value, path).map((item, index) => text(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) throw new InputError(`${path} contains duplicates`);
  return result;
}

function capabilities(value: unknown, path: string): Capability[] {
  return strings(value, path).map(item => choice(item, path, ['read', 'code', 'plan', 'review']));
}

function schema(value: unknown, path: string): 1 {
  if (value !== 1) throw new InputError(`${path}: unsupported schema version; expected 1`);
  return 1;
}

export function parseConfig(value: unknown): Config {
  const root = object(value, 'config', ['schemaVersion', 'profile', 'models', 'roles', 'limits']);
  if (root.schemaVersion !== 2) {
    if (root.schemaVersion === 1) throw new InputError('config: schema version 1 must be migrated with migrate-config');
    throw new InputError('config: unsupported schema version; expected 2');
  }
  const schemaVersion = 2 as const;
  const profile = choice(root.profile, 'profile', ['economy', 'balanced', 'quality', 'custom']);
  const rawModels = object(root.models, 'models');
  if (!Object.keys(rawModels).length) throw new InputError('models must not be empty');
  const models: Record<string, ModelDeclaration> = Object.create(null) as Record<string, ModelDeclaration>;
  const identities = new Set<string>();
  for (const [alias, raw] of Object.entries(rawModels)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(alias) || ['constructor', 'prototype', '__proto__'].includes(alias)) {
      throw new InputError(`Invalid model alias: ${alias}`);
    }
    const model = object(raw, `models.${alias}`, ['id', 'runtime', 'group', 'reasoningEfforts', 'capabilities']);
    const id = text(model.id, `${alias}.id`);
    const runtime = text(model.runtime, `${alias}.runtime`);
    const identity = JSON.stringify([runtime, id]);
    if (identities.has(identity)) throw new InputError(`Duplicate runtime/model identity: ${runtime}/${id}`);
    identities.add(identity);
    models[alias] = {
      id, runtime,
      group: choice(model.group, `${alias}.group`, ['standard', 'premium']),
      reasoningEfforts: strings(model.reasoningEfforts, `${alias}.reasoningEfforts`),
      capabilities: capabilities(model.capabilities, `${alias}.capabilities`),
    };
  }
  const rawRoles = object(root.roles, 'roles', ROLES);
  const roles = {} as Config['roles'];
  for (const role of ROLES) {
    const seen = new Set<string>();
    roles[role] = array(rawRoles[role], `roles.${role}`).map((raw, index): Candidate => {
      const candidate = object(raw, `roles.${role}[${index}]`, ['model', 'reasoning']);
      const model = text(candidate.model, `${role}.model`);
      const reasoning = text(candidate.reasoning, `${role}.reasoning`);
      const declaration = models[model];
      if (!declaration) throw new InputError(`roles.${role}: unknown model ${model}`);
      if (!declaration.reasoningEfforts.includes(reasoning)) {
        throw new InputError(`roles.${role}: ${model} does not declare reasoning ${reasoning}`);
      }
      if (!declaration.capabilities.includes(ROLE_CAPABILITY[role])) {
        throw new InputError(`roles.${role}: ${model} lacks ${ROLE_CAPABILITY[role]} capability`);
      }
      const key = JSON.stringify([model, reasoning]);
      if (seen.has(key)) throw new InputError(`roles.${role}: duplicate candidate ${model}/${reasoning}`);
      seen.add(key);
      return { model, reasoning };
    });
  }
  const limits = object(root.limits, 'limits', ['maxWorkers', 'maxPremiumWorkers', 'maxAttempts', 'turnTimeoutSeconds']);
  const maxWorkers = integer(limits.maxWorkers, 'limits.maxWorkers', 1, 16);
  return {
    schemaVersion, profile, models, roles,
    limits: {
      maxWorkers,
      maxPremiumWorkers: integer(limits.maxPremiumWorkers, 'limits.maxPremiumWorkers', 0, maxWorkers),
      maxAttempts: integer(limits.maxAttempts, 'limits.maxAttempts', 1, 5),
      turnTimeoutSeconds: integer(limits.turnTimeoutSeconds, 'limits.turnTimeoutSeconds', 1, 3600),
    },
  };
}

export function parseTask(value: unknown): TaskAssessment {
  const task = object(value, 'task', ['objective', 'complexity', 'risk', 'ambiguity', 'independentPackages']);
  return {
    objective: text(task.objective, 'task.objective'),
    complexity: choice(task.complexity, 'task.complexity', ['small', 'standard', 'complex']),
    risk: choice(task.risk, 'task.risk', ['low', 'high']),
    ambiguity: choice(task.ambiguity, 'task.ambiguity', ['clear', 'unclear']),
    independentPackages: integer(task.independentPackages, 'task.independentPackages', 1, 16),
  };
}

export function parseCatalog(value: unknown): Catalog {
  const raw = object(value, 'catalog');
  const root = object(value, 'catalog', ['schemaVersion', 'observedAt', 'models', ...(Object.hasOwn(raw, 'capabilitiesSource') ? ['capabilitiesSource'] : [])]);
  if (Object.hasOwn(root, 'capabilitiesSource') && root.capabilitiesSource !== 'configuration') throw new InputError('catalog.capabilitiesSource must be configuration when present');
  const schemaVersion = schema(root.schemaVersion, 'catalog');
  const observedAt = text(root.observedAt, 'catalog.observedAt');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) {
    throw new InputError('catalog.observedAt must be a UTC ISO timestamp');
  }
  const seen = new Set<string>();
  const models = array(root.models, 'catalog.models', false).map((raw, index) => {
    const model = object(raw, `catalog.models[${index}]`, ['id', 'runtime', 'reasoningEfforts', 'capabilities']);
    const id = text(model.id, 'catalog.model.id');
    const runtime = text(model.runtime, 'catalog.model.runtime');
    const key = JSON.stringify([runtime, id]);
    if (seen.has(key)) throw new InputError(`Duplicate catalog identity: ${runtime}/${id}`);
    seen.add(key);
    return { id, runtime, reasoningEfforts: strings(model.reasoningEfforts, 'catalog.reasoningEfforts'), capabilities: capabilities(model.capabilities, 'catalog.capabilities') };
  });
  return { schemaVersion, observedAt, models, ...(root.capabilitiesSource === 'configuration' ? { capabilitiesSource: 'configuration' as const } : {}) };
}
