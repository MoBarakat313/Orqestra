import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateConfig } from '../core/migration.js';
import { InputError } from '../core/validation.js';

export interface FileMigrationResult {
  path: string;
  backup: string | null;
  fromVersion: number;
  toVersion: number;
  changed: boolean;
}

export async function migrateConfigFile(path: string): Promise<FileMigrationResult> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new InputError(`${path}: expected a real JSON file no larger than 1 MiB`);
  let value: unknown;
  const original = await readFile(path);
  try { value = JSON.parse(original.toString('utf8')) as unknown; }
  catch (error) {
    if (error instanceof SyntaxError) throw new InputError(`${path}: invalid JSON`);
    throw error;
  }
  const result = migrateConfig(value);
  if (!result.changed) return { path, backup: null, fromVersion: result.fromVersion, toVersion: result.toVersion, changed: false };

  const backup = `${path}.v${result.fromVersion}.bak`;
  const temporary = join(dirname(path), `.orqestra-config-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(result.config, null, 2) + '\n', { flag: 'wx', mode: info.mode & 0o777 });
  try {
    await writeFile(backup, original, { flag: 'wx', mode: info.mode & 0o777 });
  } catch (error) {
    await rm(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new InputError(`Cannot migrate config: backup already exists at ${backup}`);
    throw error;
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(backup, { force: true });
    await rm(temporary, { force: true });
    throw error;
  }
  return { path, backup, fromVersion: result.fromVersion, toVersion: result.toVersion, changed: true };
}
