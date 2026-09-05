#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseCatalog, parseConfig, parseTask, InputError } from './core/validation.js';
import { planTask } from './core/router.js';
import { createPreset } from './presets.js';
import { diagnose } from './runtime/doctor.js';
import { catalogFromDiscovery, discoverModels } from './runtime/discovery.js';
import { installSkill, uninstallSkill } from './runtime/skill-install.js';
import type { Profile, RoutePlan } from './core/types.js';

const HELP = `Orqestra — policy previews and Codex discovery

Usage:
  orqestra init [--profile economy|balanced|quality] [--config <path>]
  orqestra validate [--config <path>]
  orqestra plan --task <assessment.json> [--config <path>] [--catalog <path>]
  orqestra demo [--profile economy|balanced|quality]
  orqestra doctor [--codex <executable>]
  orqestra models [--codex <executable>] [--output <catalog.json> --config <path>]
  orqestra install-skill --project <directory>
  orqestra uninstall-skill --project <directory>

All commands support --json. Default config: ./orqestra.config.json
Plans are previews. models contacts the Codex runtime for account mode and model discovery.
No command starts a model turn or changes Codex settings.
Skill installation is project-local and preserves existing installations/settings.
Live worker execution is planned, not implemented.
`;

async function readJson(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new InputError(`${path}: expected a JSON file no larger than 1 MiB`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new InputError(`${path}: invalid JSON`);
    throw error;
  }
}

function profile(value = 'balanced'): Exclude<Profile, 'custom'> {
  if (value !== 'economy' && value !== 'balanced' && value !== 'quality') {
    throw new InputError('Profile must be economy, balanced, or quality. Edit a generated configuration for a custom policy.');
  }
  return value;
}

function formatPlan(plan: RoutePlan): string {
  const lines = [
    `Orqestra — PREVIEW ONLY`, `Task: ${plan.objective}`,
    `Profile: ${plan.profile} | Route: ${plan.route} | Verification: ${plan.verification}`,
    `Availability: ${plan.availability}${plan.catalogObservedAt ? ` (${plan.catalogObservedAt})` : ''}`,
    ...plan.reasons.map(reason => `  ${reason}`),
  ];
  for (const assignment of plan.assignments) {
    lines.push(`  ${assignment.role}: ${assignment.id} (${assignment.reasoning}, ${assignment.runtime})`);
    lines.push(`    ${assignment.reason}`);
  }
  lines.push(`Proposed parallel implementation workers: ${plan.parallelWorkers}; attempt limit: ${plan.maxAttempts}`);
  lines.push(...plan.warnings.map(warning => `Note: ${warning}`));
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string' }, profile: { type: 'string' }, task: { type: 'string' },
      catalog: { type: 'string' }, codex: { type: 'string' }, json: { type: 'boolean' },
      output: { type: 'string' },
      project: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true, strict: true,
  });
  if (values.help || !positionals.length) { console.log(values.json ? JSON.stringify({ help: HELP }) : HELP); return; }
  if (positionals.length !== 1) throw new InputError('Expected one command; use --help for usage.');
  const command = positionals[0]!;
  const allowed: Record<string, string[]> = {
    init: ['profile', 'config'], validate: ['config'], plan: ['task', 'config', 'catalog'], demo: ['profile'], doctor: ['codex'], models: ['codex', 'output', 'config'],
    'install-skill': ['project'], 'uninstall-skill': ['project'],
  };
  if (!Object.hasOwn(allowed, command)) throw new InputError(`Unknown command: ${command}. Live execution is not implemented; use --help.`);
  for (const key of Object.keys(values)) {
    if (!['json', 'help'].includes(key) && !allowed[command]!.includes(key)) throw new InputError(`--${key} is not valid for ${command}`);
  }
  const emit = (data: unknown, human: string): void => { console.log(values.json ? JSON.stringify(data, null, 2) : human); };
  const configPath = values.config ?? 'orqestra.config.json';
  if (command === 'init') {
    const config = parseConfig(createPreset(profile(values.profile)));
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    emit({ created: configPath, profile: config.profile, schemaVersion: config.schemaVersion }, `Created ${configPath} (${config.profile}). Existing files and Codex settings were preserved.`);
  } else if (command === 'validate') {
    const config = parseConfig(await readJson(configPath));
    emit({ valid: true, profile: config.profile, availability: 'unverified' }, `Configuration is valid (${config.profile}). Account availability is unverified.`);
  } else if (command === 'plan') {
    if (!values.task) throw new InputError('plan requires --task <assessment.json>');
    const config = parseConfig(await readJson(configPath));
    const task = parseTask(await readJson(values.task));
    const catalog = values.catalog ? parseCatalog(await readJson(values.catalog)) : undefined;
    const plan = planTask(config, task, catalog);
    emit(plan, formatPlan(plan));
  } else if (command === 'demo') {
    const config = parseConfig(createPreset(profile(values.profile)));
    const tasks = [
      { objective: 'Change a button label', complexity: 'small', risk: 'low', ambiguity: 'clear', independentPackages: 1 },
      { objective: 'Add a bounded export feature', complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 },
      { objective: 'Change a payment cancellation flow', complexity: 'complex', risk: 'high', ambiguity: 'clear', independentPackages: 1 },
      { objective: 'Implement two independently specified modules', complexity: 'complex', risk: 'low', ambiguity: 'clear', independentPackages: 2 },
    ];
    const plans = tasks.map(task => planTask(config, parseTask(task)));
    emit({ mode: 'offline-demo', plans, usage: null }, plans.map(formatPlan).join('\n\n'));
  } else if (command === 'doctor') {
    const report = await diagnose(values.codex);
    emit(report, [`Node: ${report.node.version}`, `Codex: ${report.codex.version ?? 'not detected'} (${report.codex.status})`, ...report.messages, 'Live worker execution is not implemented.'].join('\n'));
    if (!report.ready) process.exitCode = 1;
  } else if (command === 'models') {
    if (values.config && !values.output) throw new InputError('--config is only used with --output when exporting a catalog');
    const config = values.output ? parseConfig(await readJson(configPath)) : undefined;
    const report = await discoverModels(values.codex);
    if (values.output && config) {
      await writeFile(values.output, JSON.stringify(catalogFromDiscovery(report, config), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    emit({ ...report, catalogWritten: values.output ?? null }, [
      `Codex: ${report.codexVersion} | Account mode: ${report.account.mode}`,
      `Observed ${report.models.length} models at ${report.observedAt}`,
      ...report.models.map(model => `  ${model.id}: ${model.reasoningEfforts.join(', ') || 'no supported reasoning settings reported'}`),
      ...report.warnings.map(warning => `Note: ${warning}`),
      ...(values.output ? [`Wrote ${values.output}; model roles come from the selected configuration.`] : []),
      'No model turn was started.',
    ].join('\n'));
  } else if (command === 'install-skill' || command === 'uninstall-skill') {
    if (!values.project) throw new InputError(`${command} requires --project <directory>`);
    if (command === 'install-skill') {
      const result = await installSkill(values.project);
      emit(result, `Installed ${result.installed}. Open the project in Codex and use $orqestra; reload Codex if the skill is not discovered.`);
    } else {
      const result = await uninstallSkill(values.project);
      emit(result, `Removed ${result.removed}. Project instructions, policies, and Codex settings were preserved.`);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unexpected failure';
  const clean = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
  if (process.argv.includes('--json')) console.error(JSON.stringify({ error: clean }));
  else console.error(`Orqestra: ${clean}`);
  process.exitCode = 1;
});
