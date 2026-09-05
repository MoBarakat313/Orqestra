#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseCatalog, parseConfig, parseTask, InputError } from './core/validation.js';
import { planTask } from './core/router.js';
import { createPreset } from './presets.js';
import { diagnose } from './runtime/doctor.js';
import { catalogFromDiscovery, discoverModels } from './runtime/discovery.js';
import { installSkill, skillStatus, uninstallSkill, upgradeSkill } from './runtime/skill-install.js';
import { parseExecutionContract } from './core/execution.js';
import { parseCoordinationContract } from './core/coordination.js';
import { resumeDurable, runDurable, type DurableReport } from './runtime/durable.js';
import { resumeCoordinated, runCoordinated, type CoordinationReport } from './runtime/coordinator.js';
import type { Profile, RoutePlan } from './core/types.js';
import { inspectAccountUsage } from './runtime/accounting.js';
import { evaluateBenchmark, parseBenchmark } from './core/evaluation.js';
import type { UsageSummary } from './core/usage.js';
import { migrateConfigFile } from './runtime/config-migration.js';
import { setupProject } from './runtime/setup.js';
import { ORQESTRA_VERSION } from './version.js';

const HELP = `Orqestra — policy routing and durable Codex execution

Usage:
  orqestra version
  orqestra setup --project <directory> [--profile economy|balanced|quality]
  orqestra init [--profile economy|balanced|quality] [--config <path>]
  orqestra migrate-config [--config <path>]
  orqestra validate [--config <path>]
  orqestra plan --task <assessment.json> [--config <path>] [--catalog <path>]
  orqestra demo [--profile economy|balanced|quality]
  orqestra doctor [--codex <executable>]
  orqestra models [--codex <executable>] [--output <catalog.json> --config <path>]
  orqestra usage [--codex <executable>]
  orqestra benchmark --input <benchmark.json>
  orqestra run --request <execution.json> --project <directory> [--config <path>] [--codex <executable>] [--turn-timeout <seconds>] [--state-dir <directory>]
  orqestra resume --run-id <id> --request <execution.json> --project <directory> [--config <path>] [--codex <executable>] [--turn-timeout <seconds>] [--state-dir <directory>]
  orqestra coordinate --request <coordination.json> --project <directory> [--config <path>] [--codex <executable>] [--turn-timeout <seconds>]
  orqestra coordinate-resume --run-id <id> --request <coordination.json> --project <directory> [--config <path>] [--codex <executable>] [--turn-timeout <seconds>]
  orqestra install-skill --project <directory>
  orqestra skill-status --project <directory>
  orqestra upgrade-skill --project <directory>
  orqestra uninstall-skill --project <directory>

All commands support --json. Default config: ./orqestra.config.json
Plans are previews. models contacts the Codex runtime for account mode and model discovery.
run starts a durable, bounded worker run for standard, clear, low-risk work and independently verifies its changes.
resume continues a matching paused checkpoint without repeating a worker whose edits are already present.
coordinate runs dependency-aware packages in isolated worktrees and verifies their combined result.
coordinate-resume continues a matching paused coordination checkpoint without redispatching committed packages.
usage reads account-level observations without starting a model turn; ChatGPT account and API-key modes remain distinct.
benchmark evaluates recorded direct-Codex and Orqestra pairs with matching task conditions.
The worker has project-only write access and no network. Approval requests are cancelled and reported; none are granted automatically.
Skill installation is project-local and preserves existing installations/settings.
setup creates or migrates the project policy and installs or safely upgrades the project skill.
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

function boundedInteger(value: string | undefined, fallback: number, label: string, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new InputError(`${label} must be an integer between ${minimum} and ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new InputError(`${label} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
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

function formatUsage(usage: UsageSummary): string[] {
  return [
    `Usage: ${usage.attempts.measured}/${usage.attempts.total} worker turns measured | billing mode: ${usage.billingMode}`,
    ...(usage.tokens ? [`Tokens: ${usage.tokens.totalTokens} total; ${usage.tokens.inputTokens} input (${usage.tokens.cachedInputTokens} cached, ${usage.tokens.cacheWriteInputTokens} cache write); ${usage.tokens.outputTokens} output (${usage.tokens.reasoningOutputTokens} reasoning)`] : ['Tokens: unavailable']),
    `Cost: ${usage.cost.status} — ${usage.cost.reason}`,
    ...usage.gaps.map(gap => `Usage gap: ${gap}`),
  ];
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string' }, profile: { type: 'string' }, task: { type: 'string' },
      catalog: { type: 'string' }, codex: { type: 'string' }, json: { type: 'boolean' },
      output: { type: 'string' },
      input: { type: 'string' },
      project: { type: 'string' },
      request: { type: 'string' },
      'turn-timeout': { type: 'string' },
      'run-id': { type: 'string' },
      'state-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true, strict: true,
  });
  if (values.help || !positionals.length) { console.log(values.json ? JSON.stringify({ help: HELP }) : HELP); return; }
  if (positionals.length !== 1) throw new InputError('Expected one command; use --help for usage.');
  const command = positionals[0]!;
  const allowed: Record<string, string[]> = {
    version: [], setup: ['project', 'profile'],
    init: ['profile', 'config'], validate: ['config'], plan: ['task', 'config', 'catalog'], demo: ['profile'], doctor: ['codex'], models: ['codex', 'output', 'config'],
    'migrate-config': ['config'],
    usage: ['codex'], benchmark: ['input'],
    run: ['request', 'project', 'config', 'codex', 'turn-timeout', 'state-dir'],
    resume: ['run-id', 'request', 'project', 'config', 'codex', 'turn-timeout', 'state-dir'],
    coordinate: ['request', 'project', 'config', 'codex', 'turn-timeout'],
    'coordinate-resume': ['run-id', 'request', 'project', 'config', 'codex', 'turn-timeout'],
    'install-skill': ['project'], 'skill-status': ['project'], 'upgrade-skill': ['project'], 'uninstall-skill': ['project'],
  };
  if (!Object.hasOwn(allowed, command)) throw new InputError(`Unknown command: ${command}; use --help.`);
  for (const key of Object.keys(values)) {
    if (!['json', 'help'].includes(key) && !allowed[command]!.includes(key)) throw new InputError(`--${key} is not valid for ${command}`);
  }
  const emit = (data: unknown, human: string): void => { console.log(values.json ? JSON.stringify(data, null, 2) : human); };
  const configPath = values.config ?? 'orqestra.config.json';
  if (command === 'version') {
    emit({ version: ORQESTRA_VERSION }, ORQESTRA_VERSION);
  } else if (command === 'setup') {
    if (!values.project) throw new InputError('setup requires --project <directory>');
    const result = await setupProject(values.project, profile(values.profile));
    emit(result, [
      `Orqestra ${result.version} is ready in ${result.project}.`,
      `Policy: ${result.config.action} at ${result.config.path}${result.config.backup ? ` (backup: ${result.config.backup})` : ''}`,
      `Skill: ${result.skill.action} at ${result.skill.path}`,
      ...result.next,
    ].join('\n'));
  } else if (command === 'init') {
    const config = parseConfig(createPreset(profile(values.profile)));
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    emit({ created: configPath, profile: config.profile, schemaVersion: config.schemaVersion }, `Created ${configPath} (${config.profile}). Existing files and Codex settings were preserved.`);
  } else if (command === 'migrate-config') {
    const result = await migrateConfigFile(configPath);
    emit(result, result.changed
      ? `Migrated ${result.path} from schema ${result.fromVersion} to ${result.toVersion}. Backup: ${result.backup}`
      : `${result.path} already uses schema ${result.toVersion}; no files changed.`);
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
    emit(report, [`Node: ${report.node.version}`, `Codex: ${report.codex.version ?? 'not detected'} (${report.codex.status})`, ...report.messages, 'Durable worker and isolated coordination execution require explicit acceptance contracts.'].join('\n'));
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
  } else if (command === 'usage') {
    const report = await inspectAccountUsage(values.codex);
    emit(report, [
      `Codex: ${report.codexVersion} | Account mode: ${report.accountMode} | Billing mode: ${report.billingMode}`,
      `Account usage: ${report.status}`,
      ...(report.chatgpt?.rateLimits ?? []).map(bucket => `  ${bucket.limitName ?? bucket.limitId}: ${bucket.primary ? `${bucket.primary.usedPercent}% used` : 'no primary window'}`),
      ...(report.chatgpt?.tokenActivity?.lifetimeTokens === null || report.chatgpt?.tokenActivity === null || report.chatgpt === null ? [] : [`Lifetime token activity: ${report.chatgpt.tokenActivity.lifetimeTokens}`]),
      ...(report.api ? [`API accounting: ${report.api.reason}`] : []),
      ...report.warnings.map(warning => `Note: ${warning}`),
      'No model turn was started.',
    ].join('\n'));
  } else if (command === 'benchmark') {
    if (!values.input) throw new InputError('benchmark requires --input <benchmark.json>');
    const report = evaluateBenchmark(parseBenchmark(await readJson(values.input)));
    emit(report, [
      `Benchmark ${report.benchmarkId}: ${report.trials.executedPairs}/${report.trials.total} executed pairs`,
      `Completion: direct ${report.completion.directSucceeded}; Orqestra ${report.completion.orqestraSucceeded}`,
      `Verification: direct ${report.verification.directPassed}/${report.verification.directTotal}; Orqestra ${report.verification.orqestraPassed}/${report.verification.orqestraTotal}`,
      `Regressions: direct ${report.regressions.direct}; Orqestra ${report.regressions.orqestra}`,
      `Retries: direct ${report.retries.direct}; Orqestra ${report.retries.orqestra}`,
      `Elapsed difference: ${report.elapsedMs.difference} ms`,
      ...(report.tokens ? [`Measured paired token difference: ${report.tokens.difference.totalTokens}`] : ['Measured paired token difference: unavailable']),
      ...(report.apiCostUsd ? [`Measured paired API cost difference: $${report.apiCostUsd.difference.toFixed(6)}`] : ['Measured paired API cost difference: unavailable']),
      ...report.warnings.map(warning => `Note: ${warning}`),
    ].join('\n'));
  } else if (command === 'run' || command === 'resume') {
    if (!values.request || !values.project) throw new InputError(`${command} requires --request <execution.json> and --project <directory>`);
    if (command === 'resume' && !values['run-id']) throw new InputError('resume requires --run-id <id>');
    const config = parseConfig(await readJson(configPath));
    const contract = parseExecutionContract(await readJson(values.request));
    const plan = planTask(config, contract.task);
    if (plan.route !== 'single') throw new InputError(`M4 runs only the single-worker route; this task routes to ${plan.route}`);
    const assignment = plan.assignments.find(candidate => candidate.role === 'implement');
    if (!assignment) throw new InputError('The selected plan has no implementation worker');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    let report: DurableReport;
    try {
      const options = {
        project: values.project, ...(values.codex ? { executable: values.codex } : {}),
        turnTimeoutSeconds: boundedInteger(values['turn-timeout'], config.limits.turnTimeoutSeconds, '--turn-timeout', 1, 3600),
        signal: controller.signal, maxAttempts: plan.maxAttempts,
        ...(values['state-dir'] ? { stateDirectory: values['state-dir'] } : {}),
      };
      report = command === 'run'
        ? await runDurable(contract, assignment, options)
        : await resumeDurable(values['run-id']!, contract, assignment, options);
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
    emit(report, [
      `Orqestra run ${report.runId}: ${report.status}`,
      `Model: ${report.selected.id} (${report.selected.reasoning}) | attempts: ${report.attempts}`,
      `Checkpoint: ${report.statePath}`,
      `Changed files: ${report.changes.changedFiles.join(', ') || 'none'}`,
      ...(report.latestWorker?.verification ?? []).map(check => `Verification ${check.name}: ${check.status}`),
      ...report.warnings.map(warning => `Note: ${warning}`),
      ...formatUsage(report.usage),
    ].join('\n'));
    if (report.status !== 'succeeded') process.exitCode = 1;
  } else if (command === 'coordinate' || command === 'coordinate-resume') {
    if (!values.request || !values.project) throw new InputError(`${command} requires --request <coordination.json> and --project <directory>`);
    if (command === 'coordinate-resume' && !values['run-id']) throw new InputError('coordinate-resume requires --run-id <id>');
    const config = parseConfig(await readJson(configPath));
    const contract = parseCoordinationContract(await readJson(values.request));
    const plan = planTask(config, contract.task);
    if (!['planned', 'coordinated'].includes(plan.route)) throw new InputError(`M5 coordination requires a multi-package planned or coordinated route; this task routes to ${plan.route}`);
    const assignment = plan.assignments.find(candidate => candidate.role === 'implement');
    if (!assignment) throw new InputError('The selected plan has no implementation worker');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    let report: CoordinationReport;
    try {
      const options = {
        project: values.project, maxAttempts: config.limits.maxAttempts,
        maxWorkers: config.limits.maxWorkers, maxPremiumWorkers: config.limits.maxPremiumWorkers,
        ...(values.codex ? { executable: values.codex } : {}),
        turnTimeoutSeconds: boundedInteger(values['turn-timeout'], config.limits.turnTimeoutSeconds, '--turn-timeout', 1, 3600),
        signal: controller.signal,
      };
      report = command === 'coordinate'
        ? await runCoordinated(contract, assignment, options)
        : await resumeCoordinated(values['run-id']!, contract, assignment, options);
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
    emit(report, [
      `Orqestra coordination ${report.runId}: ${report.status}`,
      `Model: ${report.selected.id} (${report.selected.reasoning})`,
      `Observed concurrency: ${report.maxConcurrentObserved}/${report.limits.maxWorkers}; premium: ${report.maxPremiumObserved}/${report.limits.maxPremiumWorkers}`,
      `Checkpoint: ${report.statePath}`,
      ...report.packages.map(item => `Package ${item.id}: ${item.status}${item.commit ? ` (${item.commit.slice(0, 12)})` : ''}`),
      `Integration owner: ${report.integration.owner} | status: ${report.integration.status}`,
      `Integration worktree: ${report.integration.worktree}`,
      ...report.integration.verification.map(check => `Verification ${check.name}: ${check.status}`),
      ...report.warnings.map(warning => `Note: ${warning}`),
      ...formatUsage(report.usage),
    ].join('\n'));
    if (report.status !== 'succeeded') process.exitCode = 1;
  } else if (command === 'install-skill' || command === 'skill-status' || command === 'upgrade-skill' || command === 'uninstall-skill') {
    if (!values.project) throw new InputError(`${command} requires --project <directory>`);
    if (command === 'install-skill') {
      const result = await installSkill(values.project);
      emit(result, `Installed Orqestra ${result.version} at ${result.installed}. Open the project in Codex and use $orqestra; reload Codex if the skill is not discovered.`);
    } else if (command === 'skill-status') {
      const result = await skillStatus(values.project);
      emit(result, result.installed
        ? `Orqestra skill ${result.version ?? 'legacy'} is installed at ${result.path}${result.current ? ' and is current.' : ' and can be upgraded.'}`
        : `Orqestra is not installed at ${result.path}.`);
    } else if (command === 'upgrade-skill') {
      const result = await upgradeSkill(values.project);
      emit(result, `Upgraded ${result.upgraded} from ${result.fromVersion ?? 'legacy'} to ${result.toVersion}. Local ownership checks passed.`);
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
