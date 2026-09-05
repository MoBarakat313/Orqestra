import { access, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Profile } from '../core/types.js';
import { createPreset } from '../presets.js';
import { ORQESTRA_VERSION } from '../version.js';
import { migrateConfigFile } from './config-migration.js';
import { installSkill, skillStatus, upgradeSkill } from './skill-install.js';

export interface SetupResult {
  version: string;
  project: string;
  config: { path: string; action: 'created' | 'migrated' | 'preserved'; backup: string | null };
  skill: { path: string; action: 'installed' | 'upgraded' | 'current'; fromVersion: string | null };
  next: string[];
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function setupProject(project: string, profile: Exclude<Profile, 'custom'>): Promise<SetupResult> {
  const root = await realpath(project);
  const before = await skillStatus(root); // Verify ownership before changing configuration.
  const configPath = join(root, 'orqestra.config.json');
  let config: SetupResult['config'];
  if (await exists(configPath)) {
    const migration = await migrateConfigFile(configPath);
    config = { path: configPath, action: migration.changed ? 'migrated' : 'preserved', backup: migration.backup };
  } else {
    await writeFile(configPath, JSON.stringify(createPreset(profile), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    config = { path: configPath, action: 'created', backup: null };
  }

  try {
    let skill: SetupResult['skill'];
    if (!before.installed) {
      const installed = await installSkill(root);
      skill = { path: installed.installed, action: 'installed', fromVersion: null };
    } else if (before.current) {
      skill = { path: before.path, action: 'current', fromVersion: before.version };
    } else {
      const upgraded = await upgradeSkill(root);
      skill = { path: upgraded.upgraded, action: 'upgraded', fromVersion: upgraded.fromVersion };
    }
    return {
      version: ORQESTRA_VERSION,
      project: root,
      config,
      skill,
      next: ['Reload Codex if the skill is not visible.', 'Ask: $orqestra preview a plan for my task', 'Run: orqestra doctor'],
    };
  } catch (error) {
    if (config.action === 'created') await rm(configPath, { force: true });
    else if (config.action === 'migrated' && config.backup) {
      await rm(configPath, { force: true });
      await rename(config.backup, configPath);
    }
    throw error;
  }
}
