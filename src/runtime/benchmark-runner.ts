import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { BenchmarkRunSpec } from '../core/benchmark-run.js';
import type { VerificationCommand } from '../core/execution.js';
import { evaluateBenchmark, type BenchmarkInput, type BenchmarkObservation } from '../core/evaluation.js';
import { planTask } from '../core/router.js';
import type { Config } from '../core/types.js';
import { addTokens, parseTokenUsageBreakdown, type AccountMode, type TokenUsageBreakdown } from '../core/usage.js';
import { InputError } from '../core/validation.js';
import { ORQESTRA_VERSION } from '../version.js';
import { catalogFromDiscovery, discoverModels } from './discovery.js';
import { runDurable } from './durable.js';
import { executableCommand } from './executable.js';
import { ProtocolError } from './stdio-client.js';
import { createDetachedWorktree, benchmarkRoot } from './worktree.js';
import { snapshotProject, verifyContract, workerPrompt, type CommandResult } from './worker.js';

interface DirectCapture {
  completed: boolean;
  tokens: TokenUsageBreakdown | null;
  eventSha256: string;
  eventBytes: number;
  eventCount: number;
  failure: 'exit' | 'invalid-output' | 'timeout' | 'cancelled' | null;
}

interface ArmEvidence {
  worktree: string;
  changedFiles: string[];
  evidenceSha256: string | null;
  evidenceBytes: number;
  eventEvidence: Array<{ sha256: string; bytes: number; events: number; usageMeasured: boolean }>;
  warnings: string[];
}

export interface AutomatedBenchmarkTrial {
  id: string;
  order: ['direct-codex', 'orqestra'] | ['orqestra', 'direct-codex'];
  direct: BenchmarkObservation;
  orqestra: BenchmarkObservation;
  evidence: { direct: ArmEvidence; orqestra: ArmEvidence };
}

export interface AutomatedBenchmarkReport {
  schemaVersion: 1;
  mode: 'automated-benchmark-run';
  runId: string;
  benchmarkId: string;
  taskId: string;
  createdAt: string;
  sourceProject: string;
  baseCommit: string;
  contractSha256: string;
  policySha256: string;
  environment: { platform: string; architecture: string; nodeVersion: string; codexVersion: string; orqestraVersion: string; accountMode: AccountMode };
  comparison: {
    repetitions: number;
    order: BenchmarkRunSpec['order'];
    direct: { model: string; reasoning: string };
    orqestra: { model: string; reasoning: string };
    matchedModel: boolean;
  };
  trials: AutomatedBenchmarkTrial[];
  benchmark: ReturnType<typeof evaluateBenchmark>;
  artifacts: { root: string; ledger: string; report: string };
  warnings: string[];
}

const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 1024 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InputError(`${path} must be a nonnegative safe integer`);
  return value;
}

function directTokens(value: unknown): TokenUsageBreakdown {
  const usage = record(value, 'direct Codex turn usage');
  const inputTokens = integer(usage.input_tokens, 'direct Codex input_tokens');
  const outputTokens = integer(usage.output_tokens, 'direct Codex output_tokens');
  const totalTokens = usage.total_tokens === undefined ? inputTokens + outputTokens : integer(usage.total_tokens, 'direct Codex total_tokens');
  if (!Number.isSafeInteger(totalTokens)) throw new InputError('direct Codex total tokens exceed the safe integer limit');
  return parseTokenUsageBreakdown({
    inputTokens,
    cachedInputTokens: integer(usage.cached_input_tokens ?? 0, 'direct Codex cached_input_tokens'),
    cacheWriteInputTokens: integer(usage.cache_write_input_tokens ?? 0, 'direct Codex cache_write_input_tokens'),
    outputTokens,
    reasoningOutputTokens: integer(usage.reasoning_output_tokens ?? 0, 'direct Codex reasoning_output_tokens'),
    totalTokens,
  }, 'direct Codex turn usage');
}

async function captureDirectTurn(executable: string, project: string, model: string, reasoning: string, prompt: string, timeoutSeconds: number, signal?: AbortSignal): Promise<DirectCapture> {
  const resolved = executableCommand(executable);
  const args = [...resolved.prefix, 'exec', '--json', '--model', model,
    '--config', `model_reasoning_effort=${JSON.stringify(reasoning)}`,
    '--config', 'approval_policy="never"',
    '--config', 'sandbox_workspace_write.network_access=false',
    '--sandbox', 'workspace-write'];
  return await new Promise(resolve => {
    const child = spawn(resolved.command, args, { cwd: project, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const hash = createHash('sha256');
    let buffer = '';
    let bytes = 0;
    let events = 0;
    let completed = false;
    let tokens: TokenUsageBreakdown | null = null;
    let failure: DirectCapture['failure'] = null;
    let settled = false;
    const finish = (kind: DirectCapture['failure']): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      resolve({ completed, tokens, eventSha256: hash.digest('hex'), eventBytes: bytes, eventCount: events, failure: failure ?? kind });
    };
    const stop = (kind: Exclude<DirectCapture['failure'], null>): void => {
      if (failure) return;
      failure = kind;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      force.unref();
    };
    const parseLine = (line: string): void => {
      if (failure) return;
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) { stop('invalid-output'); return; }
      try {
        const event = record(JSON.parse(line) as unknown, 'direct Codex event');
        events++;
        if (event.type === 'turn.completed') {
          const observed = directTokens(event.usage);
          tokens = tokens ? addTokens(tokens, observed) : observed;
          completed = true;
        } else if (event.type === 'turn.failed' || event.type === 'error') {
          completed = false;
        }
      } catch { stop('invalid-output'); }
    };
    const abort = (): void => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutSeconds * 1000);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      hash.update(chunk);
      if (bytes > MAX_EVENT_BYTES) { stop('invalid-output'); return; }
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        parseLine(line);
      }
    });
    child.stderr.on('data', () => {});
    child.once('error', () => finish('exit'));
    child.once('close', code => {
      if (buffer) parseLine(buffer.replace(/\r$/u, ''));
      if (code !== 0 && !failure) failure = 'exit';
      finish(null);
    });
    child.stdin.on('error', () => stop('exit'));
    child.stdin.end(prompt);
  });
}

function checksPassed(checks: CommandResult[], contract: VerificationCommand[]): boolean {
  return checks.length === contract.length && checks.every(check => check.status === 'passed');
}

function checkSummary(checks: CommandResult[]): string {
  const failure = checks.find(check => check.status !== 'passed');
  return failure ? `${failure.name}: ${failure.status}${failure.exitCode === null ? '' : ` (exit ${failure.exitCode})`}` : 'The previous attempt did not produce a verifiable change.';
}

function verificationCounts(checks: CommandResult[], total: number): { passed: number; total: number } {
  return { passed: checks.filter(check => check.status === 'passed').length, total };
}

function emptyEvidence(worktree: string): ArmEvidence {
  return { worktree, changedFiles: [], evidenceSha256: null, evidenceBytes: 0, eventEvidence: [], warnings: [] };
}

async function runDirectArm(options: {
  executable: string; project: string; model: string; reasoning: string; spec: BenchmarkRunSpec;
  accountMode: AccountMode; maxAttempts: number; timeoutSeconds: number; signal?: AbortSignal;
}): Promise<{ observation: BenchmarkObservation; evidence: ArmEvidence }> {
  const started = Date.now();
  const captures: DirectCapture[] = [];
  let snapshot = await snapshotProject(options.project);
  const baselineHead = snapshot.head;
  let checks: CommandResult[] = [];
  let succeeded = false;
  let previousFailure = 'No prior failure.';
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const prompt = workerPrompt(options.spec.execution, attempt === 1 ? undefined : { attempt, previousFailure });
    const capture = await captureDirectTurn(options.executable, options.project, options.model, options.reasoning, prompt, options.timeoutSeconds, options.signal);
    captures.push(capture);
    snapshot = await snapshotProject(options.project);
    if (snapshot.head !== baselineHead) break;
    checks = capture.completed && snapshot.changedFiles.length ? await verifyContract(options.project, options.spec.execution.verification, options.signal) : [];
    succeeded = capture.failure === null && capture.completed && snapshot.changedFiles.length > 0 && checksPassed(checks, options.spec.execution.verification);
    if (succeeded || capture.failure === 'cancelled' || options.signal?.aborted) break;
    previousFailure = checkSummary(checks);
  }
  const measured = captures.filter(capture => capture.tokens !== null);
  const tokens = measured.length ? measured.reduce((sum, capture) => sum ? addTokens(sum, capture.tokens!) : { ...capture.tokens! }, null as TokenUsageBreakdown | null) : null;
  const evidence: ArmEvidence = {
    worktree: options.project, changedFiles: snapshot.changedFiles, evidenceSha256: snapshot.evidenceSha256, evidenceBytes: snapshot.evidenceBytes,
    eventEvidence: captures.map(capture => ({ sha256: capture.eventSha256, bytes: capture.eventBytes, events: capture.eventCount, usageMeasured: capture.tokens !== null })),
    warnings: [
      'Direct Codex JSONL event content was not persisted; only bounded counts, usage, and a SHA-256 digest were retained.',
      ...(measured.length < captures.length ? [`${captures.length - measured.length} of ${captures.length} direct turns lacked final usage telemetry.`] : []),
    ],
  };
  return {
    observation: {
      source: 'direct-codex', observedAt: new Date().toISOString(), status: succeeded ? 'succeeded' : 'failed',
      verification: verificationCounts(checks, options.spec.execution.verification.length), regressions: 0,
      retries: Math.max(0, captures.length - 1), elapsedMs: Date.now() - started,
      usage: {
        accountMode: options.accountMode, tokens, apiCostUsd: null,
        models: [{ model: options.model, reasoning: options.reasoning, turns: captures.length, measuredTurns: measured.length, tokens }],
      },
    }, evidence,
  };
}

async function prepare(worktree: string, commands: VerificationCommand[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ProtocolError('Benchmark run was cancelled');
  if (commands.length) {
    const checks = await verifyContract(worktree, commands, signal);
    if (signal?.aborted) throw new ProtocolError('Benchmark run was cancelled');
    if (!checksPassed(checks, commands)) throw new ProtocolError(`Benchmark preparation failed: ${checkSummary(checks)}`);
  }
  const snapshot = await snapshotProject(worktree);
  if (snapshot.changedFiles.length) throw new ProtocolError('Benchmark preparation changed Git-visible files; preparation must leave a clean worktree');
}

function orderFor(spec: BenchmarkRunSpec, repetition: number): AutomatedBenchmarkTrial['order'] {
  if (spec.order === 'direct-first' || (spec.order === 'alternating' && repetition % 2 === 0)) return ['direct-codex', 'orqestra'];
  return ['orqestra', 'direct-codex'];
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function runAutomatedBenchmark(spec: BenchmarkRunSpec, config: Config, options: { project: string; executable?: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<AutomatedBenchmarkReport> {
  const sourceProject = await realpath(options.project);
  const info = await lstat(sourceProject);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('Benchmark project must be a real directory');
  const initial = await snapshotProject(sourceProject);
  if (initial.changedFiles.length) throw new ProtocolError('A clean Git working tree is required before creating benchmark trials');
  const baseCommit = initial.head;
  const executable = options.executable ?? 'codex';
  const discovery = await discoverModels(executable);
  const plan = planTask(config, spec.execution.task, catalogFromDiscovery(discovery, config));
  if (plan.route !== 'single') throw new InputError(`Automated benchmark runs currently require a single-worker task; this task routes to ${plan.route}`);
  const assignment = plan.assignments.find(candidate => candidate.role === 'implement');
  if (!assignment || assignment.runtime !== 'codex') throw new InputError('The benchmark plan has no compatible Codex implementation worker');
  const direct = { model: spec.direct.model ?? assignment.id, reasoning: spec.direct.reasoning ?? assignment.reasoning };
  const directAvailable = discovery.models.find(model => model.id === direct.model && model.reasoningEfforts.includes(direct.reasoning));
  if (!directAvailable) throw new InputError(`Direct benchmark model ${direct.model} does not expose reasoning ${direct.reasoning} in the observed Codex catalog`);
  const timeoutSeconds = options.timeoutSeconds ?? config.limits.turnTimeoutSeconds;
  const runId = randomUUID();
  const root = await benchmarkRoot(sourceProject, runId);
  const ledgerPath = join(root, 'benchmark.json');
  const reportPath = join(root, 'report.json');
  const contractSha256 = digest({ execution: spec.execution, preparation: spec.preparation, direct, orqestra: { model: assignment.id, reasoning: assignment.reasoning }, maxAttempts: plan.maxAttempts, timeoutSeconds });
  const policySha256 = digest(config);
  const ledger: BenchmarkInput = {
    schemaVersion: 2, benchmarkId: spec.benchmarkId,
    trials: Array.from({ length: spec.repetitions }, (_, index) => ({
      id: `${spec.taskId}-${String(index + 1).padStart(2, '0')}`, taskId: spec.taskId, contractSha256, baseCommit, direct: null, orqestra: null,
    })),
  };
  await writePrivateJson(ledgerPath, ledger);
  const trials: AutomatedBenchmarkTrial[] = [];
  for (let repetition = 0; repetition < spec.repetitions; repetition++) {
    if (options.signal?.aborted) throw new ProtocolError('Benchmark run was cancelled');
    const id = ledger.trials[repetition]!.id;
    const directWorktree = join(root, 'worktrees', `${String(repetition + 1).padStart(2, '0')}-direct`);
    const orqestraWorktree = join(root, 'worktrees', `${String(repetition + 1).padStart(2, '0')}-orqestra`);
    await createDetachedWorktree(sourceProject, directWorktree, baseCommit);
    await createDetachedWorktree(sourceProject, orqestraWorktree, baseCommit);
    await prepare(directWorktree, spec.preparation, options.signal);
    await prepare(orqestraWorktree, spec.preparation, options.signal);
    const order = orderFor(spec, repetition);
    let directResult: Awaited<ReturnType<typeof runDirectArm>> | null = null;
    let orqestraResult: { observation: BenchmarkObservation; evidence: ArmEvidence } | null = null;
    for (const arm of order) {
      if (arm === 'direct-codex') {
        directResult = await runDirectArm({ executable, project: directWorktree, model: direct.model, reasoning: direct.reasoning, spec, accountMode: discovery.account.mode, maxAttempts: plan.maxAttempts, timeoutSeconds, ...(options.signal ? { signal: options.signal } : {}) });
        if (options.signal?.aborted) throw new ProtocolError('Benchmark run was cancelled');
        ledger.trials[repetition]!.direct = directResult.observation;
      } else {
        const started = Date.now();
        const evidence = emptyEvidence(orqestraWorktree);
        try {
          const report = await runDurable(spec.execution, assignment, {
            project: orqestraWorktree, executable, maxAttempts: plan.maxAttempts, turnTimeoutSeconds: timeoutSeconds,
            stateDirectory: join(root, 'state', `${String(repetition + 1).padStart(2, '0')}-orqestra`),
            ...(options.signal ? { signal: options.signal } : {}),
          });
          if (options.signal?.aborted) throw new ProtocolError('Benchmark run was cancelled');
          const checks = report.latestWorker?.verification ?? [];
          evidence.changedFiles = report.changes.changedFiles;
          evidence.evidenceSha256 = report.changes.evidenceSha256;
          evidence.evidenceBytes = report.changes.evidenceBytes;
          evidence.warnings = report.usage.gaps;
          orqestraResult = {
            observation: {
              source: 'orqestra', observedAt: new Date().toISOString(), status: report.status === 'succeeded' ? 'succeeded' : 'failed',
              verification: verificationCounts(checks, spec.execution.verification.length), regressions: 0,
              retries: Math.max(0, report.attempts - 1), elapsedMs: Date.now() - started,
              usage: {
                accountMode: report.usage.accountMode === 'mixed' ? 'other' : report.usage.accountMode,
                tokens: report.usage.tokens, apiCostUsd: null,
                models: [{ model: assignment.id, reasoning: assignment.reasoning, turns: report.usage.attempts.total, measuredTurns: report.usage.attempts.measured, tokens: report.usage.tokens }],
              },
            }, evidence,
          };
        } catch {
          if (options.signal?.aborted) throw new ProtocolError('Benchmark run was cancelled');
          const snapshot = await snapshotProject(orqestraWorktree);
          evidence.changedFiles = snapshot.changedFiles;
          evidence.evidenceSha256 = snapshot.evidenceSha256;
          evidence.evidenceBytes = snapshot.evidenceBytes;
          evidence.warnings = ['The Orqestra arm failed before a normal durable report was available.'];
          orqestraResult = {
            observation: {
              source: 'orqestra', observedAt: new Date().toISOString(), status: 'failed', verification: { passed: 0, total: spec.execution.verification.length }, regressions: 0, retries: 0, elapsedMs: Date.now() - started,
              usage: { accountMode: discovery.account.mode, tokens: null, apiCostUsd: null, models: [{ model: assignment.id, reasoning: assignment.reasoning, turns: 0, measuredTurns: 0, tokens: null }] },
            }, evidence,
          };
        }
        ledger.trials[repetition]!.orqestra = orqestraResult.observation;
      }
      await writePrivateJson(ledgerPath, ledger);
    }
    if (!directResult || !orqestraResult) throw new ProtocolError('Benchmark trial did not execute both arms');
    trials.push({ id, order, direct: directResult.observation, orqestra: orqestraResult.observation, evidence: { direct: directResult.evidence, orqestra: orqestraResult.evidence } });
  }
  const result: AutomatedBenchmarkReport = {
    schemaVersion: 1, mode: 'automated-benchmark-run', runId, benchmarkId: spec.benchmarkId, taskId: spec.taskId,
    createdAt: new Date().toISOString(), sourceProject, baseCommit, contractSha256, policySha256,
    environment: { platform: platform(), architecture: arch(), nodeVersion: process.version, codexVersion: discovery.codexVersion, orqestraVersion: ORQESTRA_VERSION, accountMode: discovery.account.mode },
    comparison: { repetitions: spec.repetitions, order: spec.order, direct, orqestra: { model: assignment.id, reasoning: assignment.reasoning }, matchedModel: direct.model === assignment.id && direct.reasoning === assignment.reasoning },
    trials, benchmark: evaluateBenchmark(ledger), artifacts: { root, ledger: ledgerPath, report: reportPath },
    warnings: [
      'Preparation ran before timing and had to leave both Git worktrees clean.',
      'Each arm used the same task contract, base commit, deterministic verification commands, attempt limit, and timeout.',
      'Direct retries start fresh Codex exec turns with the bounded repair prompt because resume support is not assumed.',
      'Regression counts remain zero in automated reports; declared verification failures are reported separately and imported ledgers can record independently classified regressions.',
      'Generated worktrees and reports remain under the repository private Git directory until the user removes them.',
      'This report is measured evidence for this task and environment, not a universal token-savings claim.',
    ],
  };
  await writePrivateJson(reportPath, result);
  return result;
}
