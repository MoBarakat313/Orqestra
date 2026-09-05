import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ExecutionContract } from '../core/execution.js';
import type { Assignment } from '../core/types.js';
import { combineUsageSummaries, summarizeUsage, unavailableTurnUsage, validUsageSummary, type UsageSummary } from '../core/usage.js';
import { ProtocolError } from './stdio-client.js';
import {
  runWorker, sameSnapshot, snapshotProject, verifyContract,
  type CommandResult, type ProjectSnapshot, type WorkerOptions, type WorkerReport,
} from './worker.js';

export type DurableStatus = 'running' | 'paused' | 'succeeded' | 'worker-failed' | 'verification-failed' | 'cancelled' | 'approval-required' | 'state-conflict';
export type FailureCategory = 'runtime-interrupted' | 'worker' | 'verification' | 'cancelled' | 'approval-required' | 'state-conflict';

export interface DurableFailure {
  category: FailureCategory;
  code: string;
}

export interface StoredVerification {
  name: string;
  status: CommandResult['status'];
  exitCode: number | null;
  outputSha256: string;
  outputBytes: number;
  outputTruncated: boolean;
  durationMs: number;
}

export interface AttemptState {
  number: number;
  startedAt: string;
  completedAt: string;
  threadId: string | null;
  turnId: string | null;
  outcome: WorkerReport['status'] | 'interrupted';
  baseline: ProjectSnapshot;
  result: ProjectSnapshot;
  verification: StoredVerification[];
  workerError: WorkerReport['workerError'];
  usage?: UsageSummary;
}

interface ActiveAttempt {
  number: number;
  startedAt: string;
  threadId: string | null;
  turnId: string | null;
  baseline: ProjectSnapshot;
}

export interface DurableRunState {
  schemaVersion: 1;
  mode: 'durable-run-state';
  runId: string;
  revision: number;
  project: string;
  contractSha256: string;
  assignmentSha256: string;
  selected: { id: string; reasoning: string; runtime: string };
  maxAttempts: number;
  phase: 'ready' | 'worker-running' | 'verifying' | 'between-attempts' | 'terminal';
  status: DurableStatus;
  createdAt: string;
  updatedAt: string;
  checkpoint: ProjectSnapshot;
  activeAttempt: ActiveAttempt | null;
  attempts: AttemptState[];
  failure: DurableFailure | null;
}

export interface DurableOptions extends Omit<WorkerOptions, 'expectedBaseline' | 'ephemeral' | 'repair' | 'resumeThreadId' | 'onCheckpoint'> {
  maxAttempts: number;
  stateDirectory?: string;
  runId?: string;
}

export interface DurableReport {
  schemaVersion: 1;
  mode: 'durable-run';
  runId: string;
  statePath: string;
  status: DurableStatus;
  phase: DurableRunState['phase'];
  attempts: number;
  maxAttempts: number;
  selected: DurableRunState['selected'];
  changes: ProjectSnapshot;
  failure: DurableFailure | null;
  latestWorker: WorkerReport | null;
  warnings: string[];
  usage: UsageSummary;
}

const RUN_ID = /^[a-f0-9]{8}-[a-f0-9-]{27,55}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const PHASES = new Set<DurableRunState['phase']>(['ready', 'worker-running', 'verifying', 'between-attempts', 'terminal']);
const STATUSES = new Set<DurableStatus>(['running', 'paused', 'succeeded', 'worker-failed', 'verification-failed', 'cancelled', 'approval-required', 'state-conflict']);
const OUTCOMES = new Set<AttemptState['outcome']>(['succeeded', 'worker-failed', 'verification-failed', 'cancelled', 'approval-required', 'interrupted']);
const FAILURE_CATEGORIES = new Set<FailureCategory>(['runtime-interrupted', 'worker', 'verification', 'cancelled', 'approval-required', 'state-conflict']);

function validSnapshot(value: unknown): value is ProjectSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<ProjectSnapshot>;
  return typeof item.head === 'string' && item.head.length > 0 && item.head.length <= 256
    && Array.isArray(item.changedFiles) && item.changedFiles.length <= 1000
    && item.changedFiles.every(path => typeof path === 'string' && path.length > 0 && path.length <= 4096)
    && (item.evidenceSha256 === null || (typeof item.evidenceSha256 === 'string' && HASH.test(item.evidenceSha256)))
    && typeof item.evidenceBytes === 'number' && Number.isSafeInteger(item.evidenceBytes)
    && item.evidenceBytes >= 0 && item.evidenceBytes <= 64 * 1024 * 1024;
}

function validAttempt(value: unknown, number: number): value is AttemptState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as AttemptState;
  return item.number === number && typeof item.startedAt === 'string' && typeof item.completedAt === 'string'
    && (item.threadId === null || typeof item.threadId === 'string') && (item.turnId === null || typeof item.turnId === 'string')
    && OUTCOMES.has(item.outcome) && validSnapshot(item.baseline) && validSnapshot(item.result)
    && Array.isArray(item.verification) && item.verification.length <= 10
    && item.verification.every(check => check && typeof check === 'object' && typeof check.name === 'string'
      && ['passed', 'failed', 'timed-out', 'cancelled', 'could-not-start'].includes(check.status)
      && HASH.test(check.outputSha256) && Number.isSafeInteger(check.outputBytes) && check.outputBytes >= 0
      && typeof check.outputTruncated === 'boolean' && Number.isSafeInteger(check.durationMs) && check.durationMs >= 0)
    && (item.workerError === null || (typeof item.workerError.category === 'string'
      && (item.workerError.httpStatusCode === null || Number.isSafeInteger(item.workerError.httpStatusCode))))
    && (item.usage === undefined || validUsageSummary(item.usage));
}

function validFailure(value: unknown): value is DurableFailure | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as DurableFailure;
  return FAILURE_CATEGORIES.has(item.category) && typeof item.code === 'string' && item.code.length > 0 && item.code.length <= 120;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown-runtime-error';
  if (/App Server exited|input stream closed|output stream failed|Could not start the Codex App Server|request .* timed out|did not confirm interruption/iu.test(error.message)) return 'codex-transport-ended';
  return 'runtime-error';
}

function validAttempts(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) throw new ProtocolError('maxAttempts must be an integer between 1 and 5');
}

async function gitDirectory(project: string): Promise<string> {
  const output = await new Promise<string>((accept, reject) => {
    const child = spawn('git', ['rev-parse', '--absolute-git-dir'], { cwd: project, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 16 * 1024) chunks.push(chunk);
      else child.kill();
    });
    child.once('error', () => reject(new ProtocolError('Could not locate the Git directory for durable state')));
    child.once('close', code => code === 0 && bytes <= 16 * 1024
      ? accept(Buffer.concat(chunks).toString('utf8').trim())
      : reject(new ProtocolError('Could not locate the Git directory for durable state')));
  });
  if (!isAbsolute(output)) throw new ProtocolError('Git returned a non-absolute state directory');
  return await realpath(output);
}

async function prospectiveRealPath(path: string): Promise<string> {
  let cursor = path;
  const missing: string[] = [];
  for (;;) {
    try { return resolve(await realpath(cursor), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new ProtocolError('Could not resolve the durable state directory');
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export async function durableStatePath(projectPath: string, runId: string, stateDirectory?: string): Promise<string> {
  if (!RUN_ID.test(runId)) throw new ProtocolError('Run ID is invalid');
  const project = await realpath(projectPath);
  const root = stateDirectory ? await prospectiveRealPath(resolve(stateDirectory)) : join(await gitDirectory(project), 'orqestra', 'runs');
  if (stateDirectory) {
    const local = relative(project, root);
    if (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)) {
      throw new ProtocolError('--state-dir must be outside the project working tree');
    }
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('Durable state directory must be a real directory');
  return join(root, `${runId}.json`);
}

async function atomicWrite(path: string, state: DurableRunState, exclusive = false): Promise<void> {
  const data = JSON.stringify(state, null, 2) + '\n';
  if (Buffer.byteLength(data) > 1024 * 1024) throw new ProtocolError('Durable state exceeded 1 MiB');
  if (exclusive) {
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
    return;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
}

async function readState(path: string): Promise<DurableRunState> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new ProtocolError('Run state must be a regular JSON file no larger than 1 MiB');
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new ProtocolError('Run state is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('Run state is invalid');
  const state = value as DurableRunState;
  if (state.schemaVersion !== 1 || state.mode !== 'durable-run-state' || !RUN_ID.test(state.runId)
    || !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.project !== 'string' || !isAbsolute(state.project)
    || !HASH.test(state.contractSha256) || !HASH.test(state.assignmentSha256)
    || !state.selected || typeof state.selected.id !== 'string' || !state.selected.id || typeof state.selected.reasoning !== 'string' || !state.selected.reasoning || typeof state.selected.runtime !== 'string' || !state.selected.runtime
    || !Number.isSafeInteger(state.maxAttempts) || state.maxAttempts < 1 || state.maxAttempts > 5
    || !PHASES.has(state.phase) || !STATUSES.has(state.status)
    || !Array.isArray(state.attempts) || state.attempts.length > state.maxAttempts || !state.attempts.every((attempt, index) => validAttempt(attempt, index + 1))
    || !validSnapshot(state.checkpoint)
    || (state.activeAttempt !== null && (!state.activeAttempt || typeof state.activeAttempt !== 'object'
      || !Number.isSafeInteger(state.activeAttempt.number) || state.activeAttempt.number < 1 || state.activeAttempt.number > state.maxAttempts
      || typeof state.activeAttempt.startedAt !== 'string' || !validSnapshot(state.activeAttempt.baseline)))
    || !validFailure(state.failure)
    || (state.phase === 'terminal' && (state.status === 'running' || state.status === 'paused' || state.activeAttempt !== null))
    || (state.phase !== 'terminal' && !['running', 'paused'].includes(state.status))
    || (['worker-running', 'verifying'].includes(state.phase) && state.activeAttempt === null)
    || (['ready', 'between-attempts'].includes(state.phase) && state.activeAttempt !== null)
    || (state.activeAttempt !== null && state.activeAttempt.number !== state.attempts.length + 1)
    || (state.status === 'paused' && (!state.activeAttempt || !['worker-running', 'verifying'].includes(state.phase)))) {
    throw new ProtocolError('Run state has an unsupported or invalid shape');
  }
  return state;
}

async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const acquire = async (): Promise<void> => {
    try {
      await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let owner: unknown;
    try { owner = JSON.parse(await readFile(lock, 'utf8')); }
    catch { throw new ProtocolError('This Orqestra run has an unreadable lock; remove it only after confirming no runner is active'); }
    const pid = owner && typeof owner === 'object' && !Array.isArray(owner) ? (owner as { pid?: unknown }).pid : null;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) throw new ProtocolError('This Orqestra run has an invalid lock; remove it only after confirming no runner is active');
    let active = true;
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') active = false; }
    if (active) throw new ProtocolError('This Orqestra run is already active');
    try { await unlink(lock); }
    catch { throw new ProtocolError('Could not clear a stale Orqestra run lock'); }
    try { await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { throw new ProtocolError('Another Orqestra runner acquired the run while its stale lock was being cleared'); }
  }
  await acquire();
  try { return await action(); }
  finally { try { await unlink(lock); } catch { /* Preserve the primary result. */ } }
}

function storedVerification(results: CommandResult[]): StoredVerification[] {
  return results.map(result => ({
    name: result.name, status: result.status, exitCode: result.exitCode,
    outputSha256: createHash('sha256').update(result.output).digest('hex'),
    outputBytes: Buffer.byteLength(result.output), outputTruncated: result.outputTruncated, durationMs: result.durationMs,
  }));
}

function attemptFromReport(number: number, startedAt: string, baseline: ProjectSnapshot, result: ProjectSnapshot, report: WorkerReport): AttemptState {
  return {
    number, startedAt, completedAt: report.completedAt, threadId: report.threadId, turnId: report.turnId,
    outcome: report.status, baseline, result, verification: storedVerification(report.verification), workerError: report.workerError,
    usage: report.usage,
  };
}

function report(state: DurableRunState, statePath: string, latestWorker: WorkerReport | null): DurableReport {
  const usageParts = state.attempts.map(item => item.usage
    ?? summarizeUsage('worker-turn', [unavailableTurnUsage('other', 'This attempt predates persisted M6 usage accounting.')]));
  if (state.activeAttempt) {
    usageParts.push(summarizeUsage('worker-turn', [unavailableTurnUsage('other', 'The active attempt ended before final token telemetry could be persisted.')]));
  }
  return {
    schemaVersion: 1, mode: 'durable-run', runId: state.runId, statePath, status: state.status,
    phase: state.phase, attempts: state.attempts.length + (state.activeAttempt ? 1 : 0), maxAttempts: state.maxAttempts,
    selected: state.selected, changes: state.checkpoint, failure: state.failure, latestWorker,
    warnings: [
      'Durable state contains hashes and bounded metadata; verifier output, commands, agent messages, credentials, and backend logs are not persisted.',
      ...(state.status === 'paused' ? ['The run paused after transport loss. Resume it explicitly; Orqestra did not start a duplicate worker.'] : []),
      ...(state.status === 'verification-failed' ? ['Useful edits and verification evidence remain in the project for review.'] : []),
    ],
    usage: combineUsageSummaries('durable-run', usageParts),
  };
}

async function save(path: string, state: DurableRunState): Promise<void> {
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
  await atomicWrite(path, state);
}

function verificationFailure(results: CommandResult[]): string {
  const failed = results.find(item => item.status !== 'passed');
  if (!failed) return 'A declared verification check did not complete.';
  const output = failed.output.slice(-6000);
  return `${failed.name} ${failed.status}${failed.exitCode === null ? '' : ` with exit code ${failed.exitCode}`}${output ? `:\n${output}` : ''}`;
}

function allPassed(contract: ExecutionContract, results: CommandResult[]): boolean {
  return results.length === contract.verification.length && results.every(item => item.status === 'passed');
}

async function terminal(path: string, state: DurableRunState, status: Exclude<DurableStatus, 'running' | 'paused'>, failure: DurableFailure | null): Promise<void> {
  state.status = status;
  state.phase = 'terminal';
  state.failure = failure;
  state.activeAttempt = null;
  await save(path, state);
}

async function recoverActive(path: string, state: DurableRunState, contract: ExecutionContract, signal?: AbortSignal): Promise<string | null> {
  const active = state.activeAttempt;
  if (!active) throw new ProtocolError('Paused run has no active attempt checkpoint');
  const current = await snapshotProject(state.project);
  if (current.head !== active.baseline.head) {
    state.checkpoint = current;
    await terminal(path, state, 'state-conflict', { category: 'state-conflict', code: 'git-head-changed' });
    return null;
  }
  if (sameSnapshot(current, active.baseline)) {
    state.attempts.push({
      number: active.number, startedAt: active.startedAt, completedAt: new Date().toISOString(),
      threadId: active.threadId, turnId: active.turnId, outcome: 'interrupted', baseline: active.baseline,
      result: current, verification: [], workerError: null,
    });
    state.activeAttempt = null;
    state.checkpoint = current;
    state.phase = 'between-attempts';
    state.status = 'running';
    state.failure = { category: 'worker', code: 'interrupted-without-detected-edits' };
    await save(path, state);
    return 'The interrupted attempt left no detected working-tree edits.';
  }
  state.phase = 'verifying';
  state.status = 'running';
  state.checkpoint = current;
  await save(path, state);
  const checks = await verifyContract(state.project, contract.verification, signal);
  state.attempts.push({
    number: active.number, startedAt: active.startedAt, completedAt: new Date().toISOString(),
    threadId: active.threadId, turnId: active.turnId, outcome: allPassed(contract, checks) ? 'succeeded' : signal?.aborted ? 'cancelled' : 'verification-failed',
    baseline: active.baseline, result: current, verification: storedVerification(checks), workerError: null,
  });
  state.activeAttempt = null;
  if (allPassed(contract, checks)) {
    await terminal(path, state, 'succeeded', null);
    return null;
  }
  if (signal?.aborted || checks.some(item => item.status === 'cancelled')) {
    await terminal(path, state, 'cancelled', { category: 'cancelled', code: 'cancelled-during-recovery-verification' });
    return null;
  }
  state.phase = 'between-attempts';
  state.status = 'running';
  state.failure = { category: 'verification', code: 'recovered-edits-failed-verification' };
  await save(path, state);
  return verificationFailure(checks);
}

async function execute(path: string, state: DurableRunState, contract: ExecutionContract, assignment: Assignment, options: DurableOptions): Promise<DurableReport> {
  let latestWorker: WorkerReport | null = null;
  let previousFailure: string | null = null;
  if (state.status === 'paused' || state.phase === 'worker-running' || state.phase === 'verifying') {
    previousFailure = await recoverActive(path, state, contract, options.signal);
    if (state.phase === 'terminal') return report(state, path, null);
  } else {
    const current = await snapshotProject(state.project);
    if (!sameSnapshot(current, state.checkpoint)) {
      state.checkpoint = current;
      await terminal(path, state, 'state-conflict', { category: 'state-conflict', code: 'working-tree-checkpoint-mismatch' });
      return report(state, path, null);
    }
  }

  while (state.attempts.length < state.maxAttempts) {
    if (options.signal?.aborted) {
      await terminal(path, state, 'cancelled', { category: 'cancelled', code: 'cancelled-before-worker' });
      return report(state, path, latestWorker);
    }
    const baseline = await snapshotProject(state.project);
    if (!sameSnapshot(baseline, state.checkpoint)) {
      state.checkpoint = baseline;
      await terminal(path, state, 'state-conflict', { category: 'state-conflict', code: 'working-tree-changed-between-attempts' });
      return report(state, path, latestWorker);
    }
    const number = state.attempts.length + 1;
    state.activeAttempt = { number, startedAt: new Date().toISOString(), threadId: null, turnId: null, baseline };
    state.phase = 'worker-running';
    state.status = 'running';
    state.failure = null;
    await save(path, state);
    try {
      latestWorker = await runWorker(contract, assignment, {
        project: state.project,
        ...(options.executable ? { executable: options.executable } : {}),
        ...(options.turnTimeoutSeconds ? { turnTimeoutSeconds: options.turnTimeoutSeconds } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.approvalHandler ? { approvalHandler: options.approvalHandler } : {}),
        expectedBaseline: baseline, ephemeral: false,
        ...(state.attempts.at(-1)?.threadId ? { resumeThreadId: state.attempts.at(-1)!.threadId! } : {}),
        ...(number > 1 ? { repair: { attempt: number, previousFailure: previousFailure ?? 'The prior attempt did not satisfy the contract.' } } : {}),
        async onCheckpoint(checkpoint) {
          if (!state.activeAttempt || state.activeAttempt.number !== number) throw new ProtocolError('Run checkpoint lost its active attempt');
          if (checkpoint.phase === 'thread-started') state.activeAttempt.threadId = checkpoint.threadId;
          else if (checkpoint.phase === 'turn-started') {
            state.activeAttempt.threadId = checkpoint.threadId;
            state.activeAttempt.turnId = checkpoint.turnId;
          } else {
            state.phase = 'verifying';
            state.checkpoint = checkpoint.snapshot;
          }
          await save(path, state);
        },
      });
    } catch (error) {
      const code = cleanError(error);
      if (code === 'codex-transport-ended') {
        state.status = 'paused';
        state.failure = { category: 'runtime-interrupted', code };
        await save(path, state);
      } else {
        await terminal(path, state, 'worker-failed', { category: 'worker', code });
      }
      return report(state, path, null);
    }
    const result = await snapshotProject(state.project);
    state.attempts.push(attemptFromReport(number, state.activeAttempt.startedAt, baseline, result, latestWorker));
    state.activeAttempt = null;
    state.checkpoint = result;
    if (!latestWorker.changes.headUnchanged) {
      await terminal(path, state, 'state-conflict', { category: 'state-conflict', code: 'worker-changed-git-head' });
      return report(state, path, latestWorker);
    }
    if (latestWorker.status === 'succeeded') {
      await terminal(path, state, 'succeeded', null);
      return report(state, path, latestWorker);
    }
    if (latestWorker.status === 'cancelled') {
      await terminal(path, state, 'cancelled', { category: 'cancelled', code: 'worker-interrupted' });
      return report(state, path, latestWorker);
    }
    if (latestWorker.status === 'approval-required') {
      await terminal(path, state, 'approval-required', { category: 'approval-required', code: 'runtime-approval-requested' });
      return report(state, path, latestWorker);
    }
    previousFailure = latestWorker.status === 'verification-failed'
      ? verificationFailure(latestWorker.verification)
      : `Worker ended with ${latestWorker.status}.`;
    state.phase = 'between-attempts';
    state.failure = latestWorker.status === 'verification-failed'
      ? { category: 'verification', code: 'verification-failed' }
      : { category: 'worker', code: latestWorker.workerError?.category ?? 'worker-failed' };
    await save(path, state);
  }
  const category = state.failure?.category === 'verification' ? 'verification-failed' : 'worker-failed';
  await terminal(path, state, category, state.failure ?? { category: 'worker', code: 'attempt-limit-reached' });
  return report(state, path, latestWorker);
}

/** Start a checkpointed run. The state file is stored under Git metadata by default. */
export async function runDurable(contract: ExecutionContract, assignment: Assignment, options: DurableOptions): Promise<DurableReport> {
  validAttempts(options.maxAttempts);
  const project = await realpath(options.project);
  const info = await lstat(project);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('Project must be a real directory');
  const initial = await snapshotProject(project);
  if (initial.changedFiles.length) throw new ProtocolError('A new durable run requires a clean Git working tree');
  const runId = options.runId ?? randomUUID();
  const path = await durableStatePath(project, runId, options.stateDirectory);
  const now = new Date().toISOString();
  const state: DurableRunState = {
    schemaVersion: 1, mode: 'durable-run-state', runId, revision: 0, project,
    contractSha256: hash(contract), assignmentSha256: hash(assignment),
    selected: { id: assignment.id, reasoning: assignment.reasoning, runtime: assignment.runtime },
    maxAttempts: options.maxAttempts, phase: 'ready', status: 'running', createdAt: now, updatedAt: now,
    checkpoint: initial, activeAttempt: null, attempts: [], failure: null,
  };
  await atomicWrite(path, state, true);
  return await withLock(path, () => execute(path, state, contract, assignment, options));
}

/** Resume a paused checkpoint using the same contract, assignment, project, and attempt limit. */
export async function resumeDurable(runId: string, contract: ExecutionContract, assignment: Assignment, options: DurableOptions): Promise<DurableReport> {
  const project = await realpath(options.project);
  const path = await durableStatePath(project, runId, options.stateDirectory);
  return await withLock(path, async () => {
    const state = await readState(path);
    if (state.project !== project) throw new ProtocolError('Run state belongs to a different project');
    if (state.contractSha256 !== hash(contract)) throw new ProtocolError('Execution contract does not match the saved run');
    if (state.assignmentSha256 !== hash(assignment)) throw new ProtocolError('Selected model assignment does not match the saved run');
    if (state.maxAttempts !== options.maxAttempts) throw new ProtocolError('Configured maxAttempts does not match the saved run');
    if (state.phase === 'terminal') return report(state, path, null);
    return await execute(path, state, contract, assignment, options);
  });
}
