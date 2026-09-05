import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoordinationContract, CoordinationPackage } from '../core/coordination.js';
import { ownsPath, packageOrder } from '../core/coordination.js';
import type { ExecutionContract } from '../core/execution.js';
import type { Assignment } from '../core/types.js';
import { durableStatePath, resumeDurable, runDurable, type DurableReport, type StoredVerification } from './durable.js';
import { ProtocolError } from './stdio-client.js';
import { sameSnapshot, snapshotProject, verifyContract, type CommandResult, type ProjectSnapshot } from './worker.js';
import {
  applyCommit, commitWorktree, committedPaths, coordinationRoot, createDetachedWorktree, gitHead, patchApplied,
} from './worktree.js';

export type PackageStatus = 'queued' | 'running' | 'paused' | 'verified' | 'committing' | 'committed' | 'failed' | 'cancelled' | 'blocked';
export type CoordinationStatus = 'running' | 'paused' | 'succeeded' | 'package-failed' | 'cancelled' | 'integration-failed' | 'state-conflict';

export interface PackageState {
  id: string;
  runId: string;
  worktree: string;
  prepared: boolean;
  status: PackageStatus;
  dependenciesApplied: string[];
  startHead: string | null;
  commit: string | null;
  attempts: number;
  failureCode: string | null;
}

export interface IntegrationState {
  owner: 'orqestra';
  worktree: string;
  prepared: boolean;
  status: 'pending' | 'applying' | 'verifying' | 'succeeded' | 'failed';
  applied: string[];
  head: string | null;
  changedFiles: string[];
  verification: StoredVerification[];
  failureCode: string | null;
}

export interface CoordinationState {
  schemaVersion: 1;
  mode: 'coordinated-run-state';
  runId: string;
  revision: number;
  project: string;
  contractSha256: string;
  assignmentSha256: string;
  selected: { id: string; reasoning: string; runtime: string; group: Assignment['group'] };
  base: ProjectSnapshot;
  maxAttempts: number;
  maxWorkers: number;
  maxPremiumWorkers: number;
  status: CoordinationStatus;
  packages: PackageState[];
  integration: IntegrationState;
  activeWorkers: number;
  activePremiumWorkers: number;
  maxConcurrentObserved: number;
  maxPremiumObserved: number;
  createdAt: string;
  updatedAt: string;
  failureCode: string | null;
}

export interface CoordinationOptions {
  project: string;
  maxAttempts: number;
  maxWorkers: number;
  maxPremiumWorkers: number;
  executable?: string;
  turnTimeoutSeconds?: number;
  signal?: AbortSignal;
  runId?: string;
}

export interface PackageReport {
  id: string;
  status: PackageStatus;
  worktree: string;
  commit: string | null;
  attempts: number;
  failureCode: string | null;
}

export interface CoordinationReport {
  schemaVersion: 1;
  mode: 'coordinated-run';
  runId: string;
  statePath: string;
  status: CoordinationStatus;
  selected: CoordinationState['selected'];
  packages: PackageReport[];
  integration: {
    owner: 'orqestra';
    status: IntegrationState['status'];
    worktree: string;
    head: string | null;
    changedFiles: string[];
    verification: CommandResult[];
  };
  maxConcurrentObserved: number;
  maxPremiumObserved: number;
  limits: { maxWorkers: number; maxPremiumWorkers: number; maxAttempts: number };
  failureCode: string | null;
  warnings: string[];
  usage: null;
}

const RUN_ID = /^[a-f0-9]{8}-[a-f0-9-]{27,55}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const PACKAGE_STATUSES = new Set<PackageStatus>(['queued', 'running', 'paused', 'verified', 'committing', 'committed', 'failed', 'cancelled', 'blocked']);
const COORDINATION_STATUSES = new Set<CoordinationStatus>(['running', 'paused', 'succeeded', 'package-failed', 'cancelled', 'integration-failed', 'state-conflict']);

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boundedLimits(options: CoordinationOptions): void {
  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 5) throw new ProtocolError('maxAttempts must be an integer between 1 and 5');
  if (!Number.isSafeInteger(options.maxWorkers) || options.maxWorkers < 1 || options.maxWorkers > 16) throw new ProtocolError('maxWorkers must be an integer between 1 and 16');
  if (!Number.isSafeInteger(options.maxPremiumWorkers) || options.maxPremiumWorkers < 0 || options.maxPremiumWorkers > options.maxWorkers) throw new ProtocolError('maxPremiumWorkers must be between 0 and maxWorkers');
}

function storedVerification(results: CommandResult[]): StoredVerification[] {
  return results.map(result => ({
    name: result.name, status: result.status, exitCode: result.exitCode,
    outputSha256: createHash('sha256').update(result.output).digest('hex'), outputBytes: Buffer.byteLength(result.output),
    outputTruncated: result.outputTruncated, durationMs: result.durationMs,
  }));
}

function executionContract(item: CoordinationPackage): ExecutionContract {
  return {
    schemaVersion: 1,
    task: { objective: item.objective, complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 },
    acceptanceCriteria: item.acceptanceCriteria,
    verification: item.verification,
  };
}

function failureCode(error: unknown, fallback: string): string {
  if (error instanceof ProtocolError && /already active/u.test(error.message)) return 'child-run-already-active';
  return fallback;
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

async function atomicWrite(path: string, state: CoordinationState, exclusive = false): Promise<void> {
  const data = JSON.stringify(state, null, 2) + '\n';
  if (Buffer.byteLength(data) > 1024 * 1024) throw new ProtocolError('Coordination state exceeded 1 MiB');
  if (exclusive) { await writeFile(path, data, { flag: 'wx', mode: 0o600 }); return; }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}

function validStoredVerification(value: unknown): value is StoredVerification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as StoredVerification;
  return typeof item.name === 'string' && ['passed', 'failed', 'timed-out', 'cancelled', 'could-not-start'].includes(item.status)
    && (item.exitCode === null || Number.isSafeInteger(item.exitCode)) && HASH.test(item.outputSha256)
    && Number.isSafeInteger(item.outputBytes) && item.outputBytes >= 0 && typeof item.outputTruncated === 'boolean'
    && Number.isSafeInteger(item.durationMs) && item.durationMs >= 0;
}

async function readState(path: string): Promise<CoordinationState> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new ProtocolError('Coordination state must be a regular JSON file no larger than 1 MiB');
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new ProtocolError('Coordination state is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('Coordination state is invalid');
  const state = value as CoordinationState;
  const packagesValid = Array.isArray(state.packages) && state.packages.length >= 2 && state.packages.length <= 16
    && state.packages.every(item => item && typeof item.id === 'string' && RUN_ID.test(item.runId) && typeof item.worktree === 'string'
      && typeof item.prepared === 'boolean' && PACKAGE_STATUSES.has(item.status) && Array.isArray(item.dependenciesApplied)
      && item.dependenciesApplied.every(id => typeof id === 'string') && (item.startHead === null || typeof item.startHead === 'string')
      && (item.commit === null || typeof item.commit === 'string') && Number.isSafeInteger(item.attempts) && item.attempts >= 0
      && (item.failureCode === null || typeof item.failureCode === 'string'));
  const integrationValid = state.integration && state.integration.owner === 'orqestra' && typeof state.integration.worktree === 'string'
    && typeof state.integration.prepared === 'boolean' && ['pending', 'applying', 'verifying', 'succeeded', 'failed'].includes(state.integration.status)
    && Array.isArray(state.integration.applied) && state.integration.applied.every(id => typeof id === 'string')
    && (state.integration.head === null || typeof state.integration.head === 'string') && Array.isArray(state.integration.changedFiles)
    && state.integration.changedFiles.every(path => typeof path === 'string') && Array.isArray(state.integration.verification)
    && state.integration.verification.every(validStoredVerification) && (state.integration.failureCode === null || typeof state.integration.failureCode === 'string');
  if (state.schemaVersion !== 1 || state.mode !== 'coordinated-run-state' || !RUN_ID.test(state.runId)
    || !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.project !== 'string'
    || !HASH.test(state.contractSha256) || !HASH.test(state.assignmentSha256) || !state.selected
    || typeof state.selected.id !== 'string' || typeof state.selected.reasoning !== 'string' || typeof state.selected.runtime !== 'string'
    || !['standard', 'premium'].includes(state.selected.group) || !COORDINATION_STATUSES.has(state.status)
    || !Number.isSafeInteger(state.maxAttempts) || !Number.isSafeInteger(state.maxWorkers) || !Number.isSafeInteger(state.maxPremiumWorkers)
    || !state.base || typeof state.base.head !== 'string' || !Array.isArray(state.base.changedFiles) || !packagesValid || !integrationValid
    || !Number.isSafeInteger(state.activeWorkers) || state.activeWorkers < 0 || !Number.isSafeInteger(state.activePremiumWorkers) || state.activePremiumWorkers < 0
    || !Number.isSafeInteger(state.maxConcurrentObserved) || state.maxConcurrentObserved < 0
    || !Number.isSafeInteger(state.maxPremiumObserved) || state.maxPremiumObserved < 0) {
    throw new ProtocolError('Coordination state has an unsupported or invalid shape');
  }
  return state;
}

async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  try { await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner: unknown;
    try { owner = JSON.parse(await readFile(lock, 'utf8')); } catch { throw new ProtocolError('This coordination run has an unreadable lock'); }
    const pid = owner && typeof owner === 'object' && !Array.isArray(owner) ? (owner as { pid?: unknown }).pid : null;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) throw new ProtocolError('This coordination run has an invalid lock');
    let active = true;
    try { process.kill(pid, 0); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') active = false; }
    if (active) throw new ProtocolError('This coordination run is already active');
    await unlink(lock);
    try { await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { throw new ProtocolError('Another Orqestra coordinator acquired the run'); }
  }
  try { return await action(); }
  finally { try { await unlink(lock); } catch { /* Preserve the primary outcome. */ } }
}

class Journal {
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly path: string, readonly state: CoordinationState) {}
  update(change: (state: CoordinationState) => void): Promise<void> {
    const next = this.pending.then(async () => {
      change(this.state);
      this.state.revision += 1;
      this.state.updatedAt = new Date().toISOString();
      await atomicWrite(this.path, this.state);
    });
    this.pending = next.catch(() => {});
    return next;
  }
}

function makeReport(state: CoordinationState, statePath: string, verification: CommandResult[] = []): CoordinationReport {
  return {
    schemaVersion: 1, mode: 'coordinated-run', runId: state.runId, statePath, status: state.status, selected: state.selected,
    packages: state.packages.map(item => ({ id: item.id, status: item.status, worktree: item.worktree, commit: item.commit, attempts: item.attempts, failureCode: item.failureCode })),
    integration: {
      owner: 'orqestra', status: state.integration.status, worktree: state.integration.worktree,
      head: state.integration.head, changedFiles: state.integration.changedFiles, verification,
    },
    maxConcurrentObserved: state.maxConcurrentObserved, maxPremiumObserved: state.maxPremiumObserved,
    limits: { maxWorkers: state.maxWorkers, maxPremiumWorkers: state.maxPremiumWorkers, maxAttempts: state.maxAttempts },
    failureCode: state.failureCode,
    warnings: [
      'Each package ran in a detached Git worktree; the original checkout was not modified.',
      'Coordination state contains hashes and bounded metadata; contracts, commands, verifier output, agent messages, credentials, and backend logs are not persisted.',
      ...(state.status === 'succeeded' ? ['The verified integrated result remains in the reported integration worktree for review.'] : []),
      ...(state.status === 'paused' ? ['At least one worker paused after transport loss. Resume this coordination run explicitly.'] : []),
    ],
    usage: null,
  };
}

async function prepareWorktree(project: string, path: string, baseHead: string): Promise<void> {
  if (!(await exists(path))) await createDetachedWorktree(project, path, baseHead);
  await assertRealDirectory(path);
  if ((await gitHead(path)) !== baseHead) throw new ProtocolError('Prepared worktree does not match the coordination base commit');
  const snapshot = await snapshotProject(path);
  if (snapshot.changedFiles.length) throw new ProtocolError('Prepared worktree is not clean');
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('Coordination worktree must be a real directory');
}

async function childExists(worktree: string, runId: string): Promise<boolean> {
  const path = await durableStatePath(worktree, runId);
  return await exists(path);
}

async function executePackage(
  item: CoordinationPackage, packageState: PackageState, state: CoordinationState, journal: Journal,
  assignment: Assignment, options: CoordinationOptions,
): Promise<void> {
  const byId = new Map(state.packages.map(candidate => [candidate.id, candidate]));
  try {
    for (const dependencyId of item.dependsOn) {
      const dependency = byId.get(dependencyId)!;
      if (!dependency.commit) throw new ProtocolError('A package dependency lacks its verified commit');
      if (!packageState.dependenciesApplied.includes(dependencyId)) {
        if (!(await patchApplied(packageState.worktree, dependency.commit))) {
          await applyCommit(packageState.worktree, dependency.commit);
        }
        await journal.update(() => { packageState.dependenciesApplied.push(dependencyId); });
      }
    }
    if (!packageState.startHead) {
      const startHead = await gitHead(packageState.worktree);
      await journal.update(() => { packageState.startHead = startHead; });
    }
    if (packageState.status === 'verified' || packageState.status === 'committing') {
      const snapshot = await snapshotProject(packageState.worktree);
      if (!snapshot.changedFiles.length && packageState.startHead !== snapshot.head) {
        const paths = await committedPaths(packageState.worktree, packageState.startHead!, snapshot.head);
        if (!paths.length || paths.some(path => !ownsPath(item, path))) throw new ProtocolError('Recovered package commit violates its owned paths');
        await journal.update(() => { packageState.commit = snapshot.head; packageState.status = 'committed'; });
        return;
      }
      if (snapshot.head === packageState.startHead && snapshot.changedFiles.length && snapshot.changedFiles.every(path => ownsPath(item, path))) {
        await journal.update(() => { packageState.status = 'committing'; });
        const recoveredCommit = await commitWorktree(packageState.worktree, `orqestra(package): ${item.id}`);
        const paths = await committedPaths(packageState.worktree, packageState.startHead!, recoveredCommit);
        if (!paths.length || paths.some(path => !ownsPath(item, path))) throw new ProtocolError('Recovered package commit violates its owned paths');
        await journal.update(() => { packageState.commit = recoveredCommit; packageState.status = 'committed'; });
        return;
      }
      throw new ProtocolError('Verified package no longer matches its checkpoint');
    }
    await journal.update(current => {
      packageState.status = 'running'; packageState.failureCode = null;
      current.activeWorkers += 1;
      if (assignment.group === 'premium') current.activePremiumWorkers += 1;
      current.maxConcurrentObserved = Math.max(current.maxConcurrentObserved, current.activeWorkers);
      current.maxPremiumObserved = Math.max(current.maxPremiumObserved, current.activePremiumWorkers);
    });
    let result: DurableReport;
    try {
      const durableOptions = {
        project: packageState.worktree, runId: packageState.runId, maxAttempts: options.maxAttempts,
        ...(options.executable ? { executable: options.executable } : {}),
        ...(options.turnTimeoutSeconds ? { turnTimeoutSeconds: options.turnTimeoutSeconds } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      result = await childExists(packageState.worktree, packageState.runId)
        ? await resumeDurable(packageState.runId, executionContract(item), assignment, durableOptions)
        : await runDurable(executionContract(item), assignment, durableOptions);
    } finally {
      await journal.update(current => {
        current.activeWorkers = Math.max(0, current.activeWorkers - 1);
        if (assignment.group === 'premium') current.activePremiumWorkers = Math.max(0, current.activePremiumWorkers - 1);
      });
    }
    await journal.update(() => { packageState.attempts = result.attempts; });
    if (result.status !== 'succeeded') {
      const status: PackageStatus = result.status === 'paused' ? 'paused' : result.status === 'cancelled' ? 'cancelled' : 'failed';
      await journal.update(() => { packageState.status = status; packageState.failureCode = result.failure?.code ?? result.status; });
      return;
    }
    const snapshot = await snapshotProject(packageState.worktree);
    if (snapshot.head !== packageState.startHead || !snapshot.changedFiles.length || snapshot.changedFiles.some(path => !ownsPath(item, path))) {
      await journal.update(() => { packageState.status = 'failed'; packageState.failureCode = 'owned-path-violation'; });
      return;
    }
    await journal.update(() => { packageState.status = 'verified'; });
    await journal.update(() => { packageState.status = 'committing'; });
    const commit = await commitWorktree(packageState.worktree, `orqestra(package): ${item.id}`);
    const paths = await committedPaths(packageState.worktree, packageState.startHead!, commit);
    if (!paths.length || paths.some(path => !ownsPath(item, path))) throw new ProtocolError('Committed package violates its owned paths');
    await journal.update(() => { packageState.commit = commit; packageState.status = 'committed'; });
  } catch (error) {
    await journal.update(() => { packageState.status = options.signal?.aborted ? 'cancelled' : 'failed'; packageState.failureCode = failureCode(error, 'package-runtime-error'); });
  }
}

async function integrate(contract: CoordinationContract, state: CoordinationState, journal: Journal, options: CoordinationOptions): Promise<CommandResult[]> {
  const original = await snapshotProject(state.project);
  if (!sameSnapshot(original, state.base)) {
    await journal.update(current => { current.status = 'state-conflict'; current.failureCode = 'original-checkout-changed'; });
    return [];
  }
  try {
    if (!state.integration.prepared) {
      await prepareWorktree(state.project, state.integration.worktree, state.base.head);
      await journal.update(current => { current.integration.prepared = true; current.integration.status = 'applying'; });
    }
    const byId = new Map(state.packages.map(item => [item.id, item]));
    for (const id of packageOrder(contract)) {
      const item = byId.get(id)!;
      if (!item.commit) throw new ProtocolError('Integration package lacks a verified commit');
      if (!state.integration.applied.includes(id)) {
        if (!(await patchApplied(state.integration.worktree, item.commit))) {
          await applyCommit(state.integration.worktree, item.commit);
        }
        await journal.update(current => { current.integration.applied.push(id); current.integration.status = 'applying'; });
      }
    }
    await journal.update(current => { current.integration.status = 'verifying'; });
    const integratedHead = await gitHead(state.integration.worktree);
    const checks = await verifyContract(state.integration.worktree, contract.verification, options.signal);
    const afterVerification = await snapshotProject(state.integration.worktree);
    const changedFiles = await committedPaths(state.integration.worktree, state.base.head);
    const head = afterVerification.head;
    const passed = checks.length === contract.verification.length && checks.every(check => check.status === 'passed')
      && head === integratedHead && !afterVerification.changedFiles.length;
    const originalAfter = await snapshotProject(state.project);
    if (!sameSnapshot(originalAfter, state.base)) {
      await journal.update(current => { current.status = 'state-conflict'; current.failureCode = 'original-checkout-changed'; current.integration.head = head; current.integration.changedFiles = changedFiles; current.integration.verification = storedVerification(checks); });
    } else if (!passed) {
      await journal.update(current => { current.status = options.signal?.aborted ? 'cancelled' : 'integration-failed'; current.failureCode = options.signal?.aborted ? 'cancelled-during-integration' : 'integration-verification-failed'; current.integration.status = 'failed'; current.integration.failureCode = current.failureCode; current.integration.head = head; current.integration.changedFiles = changedFiles; current.integration.verification = storedVerification(checks); });
    } else {
      await journal.update(current => { current.status = 'succeeded'; current.failureCode = null; current.integration.status = 'succeeded'; current.integration.failureCode = null; current.integration.head = head; current.integration.changedFiles = changedFiles; current.integration.verification = storedVerification(checks); });
    }
    return checks;
  } catch (error) {
    await journal.update(current => { current.status = options.signal?.aborted ? 'cancelled' : 'integration-failed'; current.failureCode = failureCode(error, 'integration-apply-failed'); current.integration.status = 'failed'; current.integration.failureCode = current.failureCode; });
    return [];
  }
}

async function execute(contract: CoordinationContract, assignment: Assignment, state: CoordinationState, statePath: string, options: CoordinationOptions): Promise<CoordinationReport> {
  const journal = new Journal(statePath, state);
  if (state.status === 'succeeded' || state.status === 'package-failed' || state.status === 'cancelled' || state.status === 'integration-failed' || state.status === 'state-conflict') {
    return makeReport(state, statePath);
  }
  if (state.activeWorkers || state.activePremiumWorkers) {
    await journal.update(current => { current.activeWorkers = 0; current.activePremiumWorkers = 0; });
  }
  const capacity = Math.min(state.maxWorkers, assignment.group === 'premium' ? state.maxPremiumWorkers : state.maxWorkers);
  if (capacity < 1) throw new ProtocolError('The selected model has no configured worker capacity');
  const definitions = new Map(contract.packages.map(item => [item.id, item]));
  const attempted = new Set<string>();
  const active = new Map<string, Promise<string>>();
  await journal.update(current => { current.status = 'running'; current.failureCode = null; });

  while (true) {
    if (options.signal?.aborted) {
      await journal.update(current => {
        for (const item of current.packages) if (item.status === 'queued') { item.status = 'cancelled'; item.failureCode = 'cancelled-before-dispatch'; }
      });
    }
    await journal.update(current => {
      for (const item of current.packages) {
        if (item.status !== 'queued') continue;
        const definition = definitions.get(item.id)!;
        if (definition.dependsOn.some(id => ['failed', 'cancelled', 'blocked'].includes(current.packages.find(candidate => candidate.id === id)!.status))) {
          item.status = 'blocked'; item.failureCode = 'dependency-did-not-commit';
        }
      }
    });
    while (!options.signal?.aborted && active.size < capacity) {
      const ready = state.packages.find(item => {
        if (!['queued', 'paused', 'running', 'verified', 'committing'].includes(item.status) || attempted.has(item.id)) return false;
        return definitions.get(item.id)!.dependsOn.every(id => state.packages.find(candidate => candidate.id === id)!.status === 'committed');
      });
      if (!ready) break;
      attempted.add(ready.id);
      const task = executePackage(definitions.get(ready.id)!, ready, state, journal, assignment, options).then(() => ready.id);
      active.set(ready.id, task);
    }
    if (!active.size) break;
    const completed = await Promise.race(active.values());
    active.delete(completed);
  }
  if (active.size) await Promise.allSettled(active.values());
  if (state.packages.every(item => item.status === 'committed')) {
    const checks = await integrate(contract, state, journal, options);
    return makeReport(state, statePath, checks);
  }
  await journal.update(current => {
    if (current.packages.some(item => item.status === 'paused')) { current.status = 'paused'; current.failureCode = 'worker-paused'; }
    else if (options.signal?.aborted || current.packages.some(item => item.status === 'cancelled')) { current.status = 'cancelled'; current.failureCode = 'coordination-cancelled'; }
    else { current.status = 'package-failed'; current.failureCode = 'package-did-not-commit'; }
  });
  return makeReport(state, statePath);
}

/** Start a durable dependency-aware run with one detached worktree per package. */
export async function runCoordinated(contract: CoordinationContract, assignment: Assignment, options: CoordinationOptions): Promise<CoordinationReport> {
  boundedLimits(options);
  const project = await realpath(options.project);
  const projectInfo = await lstat(project);
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) throw new ProtocolError('Project must be a real directory');
  const base = await snapshotProject(project);
  if (base.changedFiles.length) throw new ProtocolError('A new coordination run requires a clean Git working tree');
  const runId = options.runId ?? randomUUID();
  if (!RUN_ID.test(runId)) throw new ProtocolError('Run ID is invalid');
  const root = await coordinationRoot(project, runId);
  const statePath = join(root, 'state.json');
  const now = new Date().toISOString();
  const state: CoordinationState = {
    schemaVersion: 1, mode: 'coordinated-run-state', runId, revision: 0, project,
    contractSha256: hash(contract), assignmentSha256: hash(assignment),
    selected: { id: assignment.id, reasoning: assignment.reasoning, runtime: assignment.runtime, group: assignment.group },
    base, maxAttempts: options.maxAttempts, maxWorkers: options.maxWorkers, maxPremiumWorkers: options.maxPremiumWorkers,
    status: 'running', packages: contract.packages.map(item => ({
      id: item.id, runId: randomUUID(), worktree: join(root, 'worktrees', `pkg-${item.id}`), prepared: false,
      status: 'queued', dependenciesApplied: [], startHead: null, commit: null, attempts: 0, failureCode: null,
    })),
    integration: { owner: 'orqestra', worktree: join(root, 'worktrees', 'integration'), prepared: false, status: 'pending', applied: [], head: null, changedFiles: [], verification: [], failureCode: null },
    activeWorkers: 0, activePremiumWorkers: 0, maxConcurrentObserved: 0, maxPremiumObserved: 0,
    createdAt: now, updatedAt: now, failureCode: null,
  };
  await atomicWrite(statePath, state, true);
  return await withLock(statePath, async () => {
    const journal = new Journal(statePath, state);
    for (const item of state.packages) {
      await prepareWorktree(project, item.worktree, base.head);
      await journal.update(() => { item.prepared = true; });
    }
    return await execute(contract, assignment, state, statePath, options);
  });
}

/** Resume a matching nonterminal coordinated run without redispatching committed packages. */
export async function resumeCoordinated(runId: string, contract: CoordinationContract, assignment: Assignment, options: CoordinationOptions): Promise<CoordinationReport> {
  boundedLimits(options);
  if (!RUN_ID.test(runId)) throw new ProtocolError('Run ID is invalid');
  const project = await realpath(options.project);
  const root = await coordinationRoot(project, runId);
  const statePath = join(root, 'state.json');
  return await withLock(statePath, async () => {
    const state = await readState(statePath);
    if (state.project !== project || state.contractSha256 !== hash(contract) || state.assignmentSha256 !== hash(assignment)) throw new ProtocolError('Coordination inputs do not match the saved run');
    if (state.maxAttempts !== options.maxAttempts || state.maxWorkers !== options.maxWorkers || state.maxPremiumWorkers !== options.maxPremiumWorkers) throw new ProtocolError('Configured limits do not match the saved coordination run');
    if (state.maxWorkers < 1 || state.maxWorkers > 16 || state.maxPremiumWorkers < 0 || state.maxPremiumWorkers > state.maxWorkers
      || state.maxAttempts < 1 || state.maxAttempts > 5 || state.activeWorkers > state.maxWorkers
      || state.activePremiumWorkers > state.maxPremiumWorkers || state.activePremiumWorkers > state.activeWorkers
      || state.maxConcurrentObserved > state.maxWorkers || state.maxPremiumObserved > state.maxPremiumWorkers) {
      throw new ProtocolError('Saved coordination limits or observations are invalid');
    }
    if (state.packages.length !== contract.packages.length || state.integration.worktree !== join(root, 'worktrees', 'integration')) throw new ProtocolError('Coordination worktree bindings do not match the saved run');
    const order = packageOrder(contract);
    if (new Set(state.integration.applied).size !== state.integration.applied.length
      || state.integration.applied.some((id, index) => order[index] !== id)) throw new ProtocolError('Saved integration order is invalid');
    const terminal = ['succeeded', 'package-failed', 'cancelled', 'integration-failed', 'state-conflict'].includes(state.status);
    for (let index = 0; index < state.packages.length; index++) {
      const item = state.packages[index]!;
      const definition = contract.packages[index]!;
      if (item.id !== definition.id || item.worktree !== join(root, 'worktrees', `pkg-${definition.id}`)
        || new Set(item.dependenciesApplied).size !== item.dependenciesApplied.length
        || item.dependenciesApplied.some((id, dependencyIndex) => definition.dependsOn[dependencyIndex] !== id)
        || (item.status === 'committed' && !item.commit)) {
        throw new ProtocolError('Coordination package bindings do not match the saved run');
      }
      if (terminal) continue;
      if (!item.prepared) {
        await prepareWorktree(project, item.worktree, state.base.head);
        item.prepared = true;
      } else await assertRealDirectory(item.worktree);
    }
    if (!terminal && state.integration.prepared) await assertRealDirectory(state.integration.worktree);
    return await execute(contract, assignment, state, statePath, options);
  });
}
