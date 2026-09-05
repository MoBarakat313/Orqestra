import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ProtocolError } from './stdio-client.js';

export class GitOperationError extends ProtocolError {
  override name = 'GitOperationError';
  constructor(public readonly operation: string) {
    super(`Git operation failed: ${operation}`);
  }
}

async function git(cwd: string, args: string[], maximum = 4 * 1024 * 1024): Promise<Buffer> {
  return await new Promise((accept, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else accept(Buffer.concat(chunks));
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) { child.kill(); finish(new GitOperationError(args[0] ?? 'unknown')); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new GitOperationError(args[0] ?? 'unknown')));
    child.once('close', code => code === 0 ? finish() : finish(new GitOperationError(args[0] ?? 'unknown')));
    const timer = setTimeout(() => { child.kill(); finish(new GitOperationError(args[0] ?? 'unknown')); }, 30000);
  });
}

async function gitStatus(cwd: string, args: string[]): Promise<number> {
  return await new Promise((accept, reject) => {
    const child = spawn('git', args, { cwd, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new GitOperationError(args[0] ?? 'unknown')); }, 30000);
    child.once('error', () => { clearTimeout(timer); reject(new GitOperationError(args[0] ?? 'unknown')); });
    child.once('close', code => { clearTimeout(timer); accept(code ?? 1); });
  });
}

export async function gitHead(project: string): Promise<string> {
  return (await git(project, ['rev-parse', 'HEAD'], 1024)).toString('utf8').trim();
}

export async function gitCommonDirectory(project: string): Promise<string> {
  const raw = (await git(project, ['rev-parse', '--git-common-dir'], 16 * 1024)).toString('utf8').trim();
  const absolute = isAbsolute(raw) ? raw : resolve(project, raw);
  return await realpath(absolute);
}

export async function coordinationRoot(project: string, runId: string): Promise<string> {
  const root = join(await gitCommonDirectory(project), 'orqestra', 'coordinated', runId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('Coordination root must be a real directory');
  return root;
}

export async function createDetachedWorktree(project: string, path: string, head: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await git(project, ['worktree', 'add', '--detach', path, head]);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProtocolError('Git did not create a real worktree directory');
}

async function commit(worktree: string, message: string): Promise<string> {
  const hooks = join(await gitCommonDirectory(worktree), 'orqestra', 'disabled-hooks');
  await mkdir(hooks, { recursive: true, mode: 0o700 });
  await git(worktree, ['-c', `core.hooksPath=${hooks}`, '-c', 'user.name=Orqestra', '-c', 'user.email=orqestra@localhost', 'commit', '--no-gpg-sign', '--no-verify', '-m', message]);
  return await gitHead(worktree);
}

export async function commitWorktree(worktree: string, message: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  return await commit(worktree, message);
}

/** Apply one verified commit without invoking project hooks. Conflicts remain isolated in this worktree. */
export async function applyCommit(worktree: string, commitId: string): Promise<string> {
  const hooks = join(await gitCommonDirectory(worktree), 'orqestra', 'disabled-hooks');
  await mkdir(hooks, { recursive: true, mode: 0o700 });
  await git(worktree, ['-c', `core.hooksPath=${hooks}`, '-c', 'user.name=Orqestra', '-c', 'user.email=orqestra@localhost', 'cherry-pick', commitId]);
  return await gitHead(worktree);
}

export async function committedPaths(worktree: string, base: string, head = 'HEAD'): Promise<string[]> {
  const output = await git(worktree, ['diff', '--name-only', '--no-renames', '-z', base, head, '--']);
  return output.toString('utf8').split('\0').filter(Boolean);
}

export async function isAncestor(worktree: string, ancestor: string, descendant = 'HEAD'): Promise<boolean> {
  const status = await gitStatus(worktree, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (status !== 0 && status !== 1) throw new GitOperationError('merge-base');
  return status === 0;
}

export async function patchApplied(worktree: string, commitId: string): Promise<boolean> {
  const lines = (await git(worktree, ['cherry', 'HEAD', commitId], 4096)).toString('utf8').trim().split('\n').filter(Boolean);
  const target = lines.find(line => line.slice(2) === commitId);
  return target?.startsWith('-') ?? false;
}
