import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Assignment } from '../core/types.js';
import type { ExecutionContract, VerificationCommand } from '../core/execution.js';
import { diagnose } from './doctor.js';
import { readDiscovery } from './discovery.js';
import { executableCommand } from './executable.js';
import { ProtocolError, StdioClient, type ServerRequest } from './stdio-client.js';

export type ApprovalDecision = 'accept' | 'decline' | 'cancel';

export interface ApprovalRequest {
  type: 'command' | 'file-change';
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
}

export interface WorkerOptions {
  executable?: string;
  project: string;
  turnTimeoutSeconds?: number;
  signal?: AbortSignal;
  approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision;
  expectedBaseline?: ProjectSnapshot;
  ephemeral?: boolean;
  repair?: { attempt: number; previousFailure: string };
  resumeThreadId?: string;
  onCheckpoint?: (checkpoint: WorkerCheckpoint) => Promise<void> | void;
}

export interface CommandResult {
  name: string;
  command: string[];
  status: 'passed' | 'failed' | 'timed-out' | 'cancelled' | 'could-not-start';
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  durationMs: number;
}

export interface ProjectSnapshot {
  head: string;
  changedFiles: string[];
  evidenceSha256: string | null;
  evidenceBytes: number;
}

export type WorkerCheckpoint =
  | { phase: 'thread-started'; threadId: string }
  | { phase: 'turn-started'; threadId: string; turnId: string }
  | { phase: 'verification-started'; snapshot: ProjectSnapshot };

export interface WorkerReport {
  schemaVersion: 1;
  mode: 'worker-run';
  status: 'succeeded' | 'worker-failed' | 'verification-failed' | 'cancelled' | 'approval-required';
  objective: string;
  selected: { id: string; reasoning: string; runtime: string };
  attempts: 1;
  startedAt: string;
  completedAt: string;
  threadId: string | null;
  turnId: string | null;
  workerTurnStatus: 'completed' | 'failed' | 'interrupted' | null;
  workerError: { category: string; httpStatusCode: number | null } | null;
  workerSummary: string | null;
  approvals: ApprovalRequest[];
  changes: {
    changedFiles: string[];
    headUnchanged: boolean;
    evidenceSha256: string | null;
    evidenceBytes: number;
  };
  verification: CommandResult[];
  warnings: string[];
  usage: null;
}

const ERROR_CATEGORIES = new Set([
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'serverOverloaded',
  'cyberPolicy', 'misalignmentPolicyViolation', 'internalServerError', 'unauthorized', 'badRequest',
  'threadRollbackFailed', 'sandboxError', 'other', 'httpConnectionFailed', 'responseStreamConnectionFailed',
  'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'activeTurnNotSteerable',
]);

function redactedTurnError(turn: Record<string, unknown>): WorkerReport['workerError'] {
  if (!turn.error || typeof turn.error !== 'object' || Array.isArray(turn.error)) return null;
  const info = (turn.error as Record<string, unknown>).codexErrorInfo;
  if (typeof info === 'string') return { category: ERROR_CATEGORIES.has(info) ? info : 'unknown', httpStatusCode: null };
  if (!info || typeof info !== 'object' || Array.isArray(info)) return { category: 'unknown', httpStatusCode: null };
  const category = Object.keys(info).find(key => ERROR_CATEGORIES.has(key)) ?? 'unknown';
  const detail = category === 'unknown' ? null : (info as Record<string, unknown>)[category];
  const status = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>).httpStatusCode : null;
  return { category, httpStatusCode: typeof status === 'number' && Number.isSafeInteger(status) ? status : null };
}

const clean = (value: unknown, maximum: number): string | null => {
  if (typeof value !== 'string' || !value) return null;
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, maximum);
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

async function git(project: string, args: string[], maxBytes = 4 * 1024 * 1024): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    };
    const receive = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > maxBytes) { child.kill(); finish(new ProtocolError('Git evidence exceeded the byte limit')); return; }
      chunks.push(chunk);
    };
    const timer = setTimeout(() => { child.kill(); finish(new ProtocolError('Git evidence command timed out')); }, 10000);
    child.stdout.on('data', receive);
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new ProtocolError('Could not run Git evidence command')));
    child.once('close', code => code === 0 ? finish() : finish(new ProtocolError('Git evidence command failed')));
  });
}

interface StatusEntry { code: string; path: string }

function statusEntries(status: Buffer): StatusEntry[] {
  const fields = status.toString('utf8').split('\0').filter(Boolean);
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field.length < 4) throw new ProtocolError('Git returned malformed status evidence');
    entries.push({ code: field.slice(0, 2), path: field.slice(3) });
    if (field[0] === 'R' || field[0] === 'C' || field[1] === 'R' || field[1] === 'C') {
      const source = fields[++index];
      if (!source) throw new ProtocolError('Git returned malformed rename evidence');
      entries.push({ code: 'D ', path: source });
    }
    if (entries.length > 1000) throw new ProtocolError('Worker changed more than 1000 files');
  }
  return entries;
}

async function changeEvidence(project: string, status: Buffer, diff: Buffer): Promise<{ files: string[]; digest: string | null; bytes: number }> {
  const entries = statusEntries(status);
  const hash = createHash('sha256').update(status).update(diff);
  let bytes = status.length + diff.length;
  for (const entry of entries.filter(item => item.code === '??')) {
    const absolute = resolve(project, entry.path);
    const local = relative(project, absolute);
    if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new ProtocolError('Git reported an untracked path outside the project');
    const info = await lstat(absolute);
    let content: Buffer;
    if (info.isFile()) {
      if (bytes + info.size > 64 * 1024 * 1024) throw new ProtocolError('Worker change evidence exceeded the byte limit');
      content = await readFile(absolute);
    }
    else if (info.isSymbolicLink()) content = Buffer.from(await readlink(absolute));
    else throw new ProtocolError('Git reported an unsupported untracked entry');
    bytes += content.length;
    if (bytes > 64 * 1024 * 1024) throw new ProtocolError('Worker change evidence exceeded the byte limit');
    hash.update(Buffer.from(`\0${entry.path}\0${info.isSymbolicLink() ? 'link' : 'file'}\0`)).update(content);
  }
  return {
    files: entries.map(entry => clean(entry.path, 4096) ?? 'unreadable-path'),
    digest: bytes ? hash.digest('hex') : null,
    bytes,
  };
}

async function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): Promise<void> {
  if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return; } catch { /* Fall back to the direct child. */ }
  }
  try { child.kill(signal); } catch { /* The process already exited. */ }
}

async function runVerification(project: string, check: VerificationCommand, signal?: AbortSignal): Promise<CommandResult> {
  const started = Date.now();
  if (signal?.aborted) return { name: check.name, command: check.command, status: 'cancelled', exitCode: null, output: '', outputTruncated: false, durationMs: 0 };
  return await new Promise(resolve => {
    const [command, ...args] = check.command;
    const child = spawn(command!, args, {
      cwd: project, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    const receive = (chunk: Buffer): void => {
      const remaining = 64 * 1024 - bytes;
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(chunk.length, remaining);
      }
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      cancelled = true;
      void terminate(child, 'SIGTERM');
      forceTimer = setTimeout(() => { void terminate(child, 'SIGKILL'); }, 1000);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      void terminate(child, 'SIGTERM');
      forceTimer ??= setTimeout(() => { void terminate(child, 'SIGKILL'); }, 1000);
    }, check.timeoutSeconds * 1000);
    child.once('error', () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      resolve({ name: check.name, command: check.command, status: 'could-not-start', exitCode: null, output: '', outputTruncated: false, durationMs: Date.now() - started });
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      resolve({
        name: check.name, command: check.command,
        status: cancelled ? 'cancelled' : timedOut ? 'timed-out' : code === 0 ? 'passed' : 'failed', exitCode: code,
        output: Buffer.concat(chunks).toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ''),
        outputTruncated: truncated, durationMs: Date.now() - started,
      });
    });
  });
}

export async function snapshotProject(projectPath: string): Promise<ProjectSnapshot> {
  const project = await realpath(projectPath);
  const head = (await git(project, ['rev-parse', 'HEAD'], 1024)).toString('utf8').trim();
  const status = await git(project, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const diff = await git(project, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--']);
  const evidence = await changeEvidence(project, status, diff);
  return { head, changedFiles: evidence.files, evidenceSha256: evidence.digest, evidenceBytes: evidence.bytes };
}

export function sameSnapshot(left: ProjectSnapshot, right: ProjectSnapshot): boolean {
  return left.head === right.head && left.evidenceSha256 === right.evidenceSha256
    && left.evidenceBytes === right.evidenceBytes
    && left.changedFiles.length === right.changedFiles.length
    && left.changedFiles.every((path, index) => path === right.changedFiles[index]);
}

export async function verifyContract(projectPath: string, checks: VerificationCommand[], signal?: AbortSignal): Promise<CommandResult[]> {
  const project = await realpath(projectPath);
  const results: CommandResult[] = [];
  for (const check of checks) {
    const result = await runVerification(project, check, signal);
    results.push(result);
    if (result.status !== 'passed') break;
  }
  return results;
}

function prompt(contract: ExecutionContract, repair?: WorkerOptions['repair']): string {
  return [
    'You are the single bounded implementation worker for Orqestra.',
    ...(repair ? [
      `This is repair attempt ${repair.attempt}. Preserve useful existing edits and fix the remaining verification failure.`,
      `Previous verification result: ${clean(repair.previousFailure, 8000) ?? 'failure details unavailable'}`,
    ] : []),
    `Objective: ${contract.task.objective}`,
    'Acceptance criteria:',
    ...contract.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    'Work only in the current project. Follow all project instruction files. Do not commit, amend, reset, or otherwise change Git history. Do not modify ignored files, credential files, or files outside the requested implementation. Do not spawn subagents. Network access is disabled. Make the smallest complete implementation. The orchestrator will run the acceptance commands independently after your turn.',
  ].join('\n');
}

/** Run exactly one Codex turn and independently verify its working-tree result. */
export async function runWorker(contract: ExecutionContract, assignment: Assignment, options: WorkerOptions): Promise<WorkerReport> {
  if (assignment.runtime !== 'codex') throw new ProtocolError(`The worker supports only the Codex runtime, not ${assignment.runtime}`);
  const turnTimeoutSeconds = options.turnTimeoutSeconds ?? 900;
  if (!Number.isSafeInteger(turnTimeoutSeconds) || turnTimeoutSeconds < 1 || turnTimeoutSeconds > 3600) throw new ProtocolError('Turn timeout must be an integer between 1 and 3600 seconds');
  const project = await realpath(options.project);
  const info = await lstat(project);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('Project must be a real directory');
  const before = await snapshotProject(project);
  if (options.expectedBaseline) {
    if (!sameSnapshot(before, options.expectedBaseline)) throw new ProtocolError('The project no longer matches the expected Orqestra checkpoint');
  } else if (before.changedFiles.length) {
    throw new ProtocolError('A clean Git working tree is required so worker changes can be attributed safely');
  }
  const startedAt = new Date().toISOString();
  const approvals: ApprovalRequest[] = [];
  let activeThread: string | null = null;
  let activeTurn: string | null = null;
  let finalMessage: string | null = null;
  let completionResolve!: (value: Record<string, unknown>) => void;
  let completionReject!: (error: Error) => void;
  const completion = new Promise<Record<string, unknown>>((resolve, reject) => { completionResolve = resolve; completionReject = reject; });
  // Transport failure can precede the point where the turn-completion promise is awaited.
  // Keep it observed while preserving rejection for the later race.
  void completion.catch(() => {});
  const executable = options.executable ?? 'codex';
  const diagnostic = await diagnose(executable);
  if (!diagnostic.ready) throw new ProtocolError('Codex prerequisites are not met. Run orqestra doctor --codex <executable> for details.');
  const { command, prefix } = executableCommand(executable);
  const approvalHandler = options.approvalHandler ?? (() => 'cancel' as const);
  const client = new StdioClient(command, [...prefix, 'app-server'], {
    cwd: project,
    requestTimeoutMs: 15000,
    onFailure(error) { completionReject(error); },
    onNotification(method, params) {
      const body = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : null;
      if (!body) return;
      if (method === 'item/completed' && body.threadId === activeThread && body.turnId === activeTurn) {
        const item = body.item && typeof body.item === 'object' && !Array.isArray(body.item) ? body.item as Record<string, unknown> : null;
        if (item?.type === 'agentMessage') finalMessage = clean(item.text, 16000);
      }
      if (method === 'turn/completed' && body.threadId === activeThread) {
        const turn = record(body.turn, 'turn/completed turn');
        if (turn.id === activeTurn) completionResolve(turn);
      }
    },
    async onServerRequest(request: ServerRequest) {
      const type = request.method === 'item/commandExecution/requestApproval' ? 'command'
        : request.method === 'item/fileChange/requestApproval' ? 'file-change' : null;
      if (!type) throw new ProtocolError('Codex requested an unsupported action');
      const body = record(request.params, 'approval request');
      if (typeof body.threadId !== 'string' || typeof body.turnId !== 'string' || typeof body.itemId !== 'string') throw new ProtocolError('Approval request lacks scope identifiers');
      if (body.threadId !== activeThread || body.turnId !== activeTurn) throw new ProtocolError('Approval request does not match the active worker turn');
      const approval: ApprovalRequest = {
        type, requestId: String(request.id), threadId: body.threadId, turnId: body.turnId, itemId: body.itemId,
        command: clean(body.command, 4096), cwd: clean(body.cwd, 4096), reason: clean(body.reason, 1000),
      };
      approvals.push(approval);
      const decision = await approvalHandler(approval);
      if (!['accept', 'decline', 'cancel'].includes(decision)) throw new ProtocolError('Approval handler returned an invalid decision');
      return { decision };
    },
  });
  let stopReason: 'timeout' | 'signal' | null = null;
  let stopResolve!: () => void;
  const stopped = new Promise<void>(resolve => { stopResolve = resolve; });
  const abort = (): void => { if (!stopReason) { stopReason = 'signal'; stopResolve(); } };
  options.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let workerTurnStatus: WorkerReport['workerTurnStatus'] = null;
  let completedTurn: Record<string, unknown> | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  try {
    const discovery = await readDiscovery(client, diagnostic.codex.version!);
    if (discovery.account.mode === 'none') throw new ProtocolError('Codex did not report an authenticated account');
    const observed = discovery.models.find(model => model.id === assignment.id);
    if (!observed || !observed.reasoningEfforts.includes(assignment.reasoning)) {
      throw new ProtocolError(`Selected model or reasoning is unavailable: ${assignment.id}/${assignment.reasoning}`);
    }
    const threadMethod = options.resumeThreadId ? 'thread/resume' : 'thread/start';
    const started = record(await client.request(threadMethod, options.resumeThreadId ? {
      threadId: options.resumeThreadId, model: assignment.id, cwd: project,
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', serviceName: 'orqestra',
    } : {
      model: assignment.id, cwd: project, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: 'workspace-write', ephemeral: options.ephemeral ?? true, serviceName: 'orqestra',
    }), `${threadMethod} response`);
    const thread = record(started.thread, `${threadMethod} thread`);
    if (typeof thread.id !== 'string' || !thread.id) throw new ProtocolError(`${threadMethod} lacks a thread ID`);
    if (options.resumeThreadId && thread.id !== options.resumeThreadId) throw new ProtocolError('thread/resume returned a different thread ID');
    activeThread = threadId = thread.id;
    await options.onCheckpoint?.({ phase: 'thread-started', threadId });
    const turnStarted = record(await client.request('turn/start', {
      threadId, input: [{ type: 'text', text: prompt(contract, options.repair) }], cwd: project,
      approvalPolicy: 'on-request', approvalsReviewer: 'user', model: assignment.id, effort: assignment.reasoning,
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [project], networkAccess: false }, summary: 'concise',
    }), 'turn/start response');
    const turn = record(turnStarted.turn, 'turn/start turn');
    if (typeof turn.id !== 'string' || !turn.id) throw new ProtocolError('turn/start lacks a turn ID');
    activeTurn = turnId = turn.id;
    await options.onCheckpoint?.({ phase: 'turn-started', threadId, turnId });
    if (options.signal?.aborted) abort();
    timer = setTimeout(() => { if (!stopReason) { stopReason = 'timeout'; stopResolve(); } }, turnTimeoutSeconds * 1000);
    const first = await Promise.race([completion.then(value => ({ type: 'completed' as const, value })), stopped.then(() => ({ type: 'stopped' as const }))]);
    let completed: Record<string, unknown>;
    if (first.type === 'stopped') {
      await client.request('turn/interrupt', { threadId, turnId });
      completed = await Promise.race([
        completion,
        delay(5000).then(() => { throw new ProtocolError('Codex did not confirm interruption within 5 seconds'); }),
      ]);
    } else completed = first.value;
    const status = completed.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') throw new ProtocolError('turn/completed has an invalid status');
    workerTurnStatus = status;
    completedTurn = completed;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    await client.close();
  }
  const after = await snapshotProject(project);
  const files = after.changedFiles;
  const headUnchanged = before.head === after.head;
  const verification: CommandResult[] = [];
  if (workerTurnStatus === 'completed' && headUnchanged && files.length && !options.signal?.aborted) {
    await options.onCheckpoint?.({ phase: 'verification-started', snapshot: after });
    verification.push(...await verifyContract(project, contract.verification, options.signal));
  }
  let status: WorkerReport['status'];
  if (approvals.length && workerTurnStatus === 'interrupted') status = 'approval-required';
  else if (workerTurnStatus === 'interrupted' || stopReason || options.signal?.aborted) status = 'cancelled';
  else if (workerTurnStatus !== 'completed' || !headUnchanged || !files.length) status = 'worker-failed';
  else status = verification.length === contract.verification.length && verification.every(check => check.status === 'passed') ? 'succeeded' : 'verification-failed';
  return {
    schemaVersion: 1, mode: 'worker-run', status, objective: contract.task.objective,
    selected: { id: assignment.id, reasoning: assignment.reasoning, runtime: assignment.runtime }, attempts: 1,
    startedAt, completedAt: new Date().toISOString(), threadId, turnId, workerTurnStatus,
    workerError: completedTurn ? redactedTurnError(completedTurn) : null, workerSummary: finalMessage,
    approvals, changes: {
      changedFiles: files, headUnchanged,
      evidenceSha256: after.evidenceSha256,
      evidenceBytes: after.evidenceBytes,
    },
    verification,
    warnings: [
      'One worker turn was attempted. Orqestra did not retry or change the selected model.',
      'Verification commands ran directly without a shell and success requires every command to pass.',
      ...(approvals.length ? ['The runtime requested approval. Decisions came from the configured approval handler; the CLI default is cancel.'] : []),
      ...(!headUnchanged ? ['The worker changed Git history. Orqestra left the project untouched for manual review and did not report success.'] : []),
      ...(!files.length ? ['No working-tree change was detected, so Orqestra did not report success.'] : []),
    ],
    usage: null,
  };
}
