import type { Config } from './types.js';
import { InputError, parseConfig } from './validation.js';

type ObjectValue = Record<string, unknown>;

export interface ConfigMigration {
  fromVersion: number;
  toVersion: 2;
  changed: boolean;
  config: Config;
}

function record(value: unknown, label: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${label} must be an object`);
  return value as ObjectValue;
}

export function migrateConfig(value: unknown): ConfigMigration {
  const root = record(value, 'config');
  if (root.schemaVersion === 2) return { fromVersion: 2, toVersion: 2, changed: false, config: parseConfig(value) };
  if (root.schemaVersion !== 1) throw new InputError('config: no migration is available for this schema version');
  const limits = record(root.limits, 'limits');
  const migrated = {
    ...root,
    schemaVersion: 2,
    limits: { ...limits, turnTimeoutSeconds: 900 },
  };
  return { fromVersion: 1, toVersion: 2, changed: true, config: parseConfig(migrated) };
}
