import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError } from '../core/validation.js';
import { ORQESTRA_VERSION } from '../version.js';

const MANIFEST = '.orqestra-manifest.json';
type Bundle = Map<string, Buffer>;
interface OwnershipManifest {
  schemaVersion: 1 | 2;
  owner: 'orqestra';
  packageVersion: string | null;
  files: Record<string, string>;
}
const digest = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

function safeRelative(path: string): void {
  if (!path || path.includes('\\') || path.includes(':') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new InputError('Invalid skill artifact path');
  }
}

async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError(`Expected a real directory, not a file or symlink: ${path}`);
}

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const name of await readdir(join(root, relative))) {
    const path = relative ? posix.join(relative, name) : name;
    safeRelative(path);
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new InputError(`Skill contains a symlink: ${path}`);
    if (info.isDirectory()) {
      const nested = await listFiles(root, path);
      if (!nested.length) throw new InputError(`Skill contains an unexpected empty directory: ${path}`);
      result.push(...nested);
    }
    else if (info.isFile()) result.push(path);
    else throw new InputError(`Skill contains an unsupported entry: ${path}`);
  }
  return result.sort();
}

export async function buildSkillBundle(): Promise<Bundle> {
  const base = fileURLToPath(new URL('../../../', import.meta.url));
  let skill = join(base, 'skills', 'orqestra');
  try { await directory(skill); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    skill = base; // Reinstalling from a previously bundled project skill.
  }
  const bundle: Bundle = new Map();
  bundle.set('SKILL.md', await readFile(join(skill, 'SKILL.md')));
  bundle.set('scripts/orqestra.mjs', await readFile(join(skill, 'scripts', 'orqestra.mjs')));
  bundle.set('LICENSE', await readFile(join(base, 'LICENSE')));
  bundle.set('scripts/runtime/package.json', Buffer.from('{"type":"module","private":true}\n'));
  const runtime = fileURLToPath(new URL('../', import.meta.url));
  for (const path of await listFiles(runtime)) {
    if (path.endsWith('.js')) bundle.set(`scripts/runtime/${path}`, await readFile(join(runtime, path)));
  }
  return bundle;
}

function parseManifest(value: unknown): OwnershipManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Cannot manage skill: unrecognized ownership manifest');
  const raw = value as Record<string, unknown>;
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2) || raw.owner !== 'orqestra' || !raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) {
    throw new InputError('Cannot manage skill: unrecognized ownership manifest');
  }
  if (raw.schemaVersion === 2 && (typeof raw.packageVersion !== 'string' || !raw.packageVersion)) {
    throw new InputError('Cannot manage skill: unrecognized ownership manifest');
  }
  return {
    schemaVersion: raw.schemaVersion,
    owner: 'orqestra',
    packageVersion: raw.schemaVersion === 2 ? raw.packageVersion as string : null,
    files: raw.files as Record<string, string>,
  };
}

async function verifyOwnedInstallation(target: string): Promise<OwnershipManifest> {
  await directory(target);
  const actual = await listFiles(target);
  let manifest: OwnershipManifest;
  try { manifest = parseManifest(JSON.parse(await readFile(join(target, MANIFEST), 'utf8')) as unknown); }
  catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('Cannot manage skill: ownership manifest is missing or invalid');
  }
  const entries = Object.entries(manifest.files);
  if (!entries.some(([path]) => path === 'SKILL.md') || !entries.some(([path]) => path === 'scripts/runtime/cli.js')) throw new InputError('Cannot manage skill: incomplete ownership manifest');
  const expected = [...entries.map(([path]) => path), MANIFEST].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new InputError('Cannot manage skill: files were added or removed; preserve or review local changes first');
  for (const [path, hash] of entries) {
    safeRelative(path);
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash) || digest(await readFile(join(target, path.split('/').join(sep)))) !== hash) {
      throw new InputError(`Cannot manage skill: modified artifact ${path}; preserve or review local changes first`);
    }
  }
  return manifest;
}

async function writeBundle(target: string, bundle: Bundle): Promise<void> {
  const files: Record<string, string> = {};
  for (const [path, content] of bundle) {
    files[path] = digest(content);
    if (path === 'SKILL.md') continue;
    await mkdir(dirname(join(target, path)), { recursive: true });
    await writeFile(join(target, path), content, { flag: 'wx' });
  }
  await writeFile(join(target, MANIFEST), JSON.stringify({ schemaVersion: 2, owner: 'orqestra', packageVersion: ORQESTRA_VERSION, files }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(target, 'SKILL.md'), bundle.get('SKILL.md')!, { flag: 'wx' });
}

export async function installSkill(project: string, source?: Bundle): Promise<{ installed: string; version: string }> {
  const bundle = source ?? await buildSkillBundle();
  if (!bundle.has('SKILL.md') || !bundle.has('scripts/runtime/cli.js') || bundle.has(MANIFEST)) throw new InputError('Incomplete or invalid skill bundle');
  for (const path of bundle.keys()) safeRelative(path);
  const root = await realpath(project);
  await directory(root);
  const createdParents: string[] = [];
  const target = join(root, '.agents', 'skills', 'orqestra');
  let owned = false;
  try {
    for (const path of [join(root, '.agents'), join(root, '.agents', 'skills')]) {
      try { await mkdir(path); createdParents.push(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await directory(path);
    }
    await mkdir(target); // Exclusive claim; never replace an existing installation.
    owned = true;
    await writeBundle(target, bundle);
    return { installed: target, version: ORQESTRA_VERSION };
  } catch (error) {
    if (owned) await rm(target, { recursive: true, force: true });
    for (const path of createdParents.reverse()) { try { await rmdir(path); } catch { /* Preserve nonempty or concurrently used parent directories. */ } }
    throw error;
  }
}

export async function skillStatus(project: string): Promise<{ installed: boolean; path: string; version: string | null; current: boolean }> {
  const root = await realpath(project);
  await directory(root);
  const target = join(root, '.agents', 'skills', 'orqestra');
  try {
    const manifest = await verifyOwnedInstallation(target);
    return { installed: true, path: target, version: manifest.packageVersion, current: manifest.packageVersion === ORQESTRA_VERSION };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installed: false, path: target, version: null, current: false };
    throw error;
  }
}

export async function upgradeSkill(project: string, source?: Bundle): Promise<{ upgraded: string; fromVersion: string | null; toVersion: string }> {
  const bundle = source ?? await buildSkillBundle();
  if (!bundle.has('SKILL.md') || !bundle.has('scripts/runtime/cli.js') || bundle.has(MANIFEST)) throw new InputError('Incomplete or invalid skill bundle');
  for (const path of bundle.keys()) safeRelative(path);
  const root = await realpath(project);
  await directory(root);
  const parent = join(root, '.agents', 'skills');
  await directory(parent);
  const target = join(parent, 'orqestra');
  const previous = await verifyOwnedInstallation(target);
  const transaction = randomUUID();
  const staging = join(parent, `.orqestra-update-${transaction}`);
  const backup = join(parent, `.orqestra-backup-${transaction}`);
  let oldMoved = false;
  let newMoved = false;
  try {
    await mkdir(staging);
    await writeBundle(staging, bundle);
    await rename(target, backup);
    oldMoved = true;
    await rename(staging, target);
    newMoved = true;
    await rm(backup, { recursive: true });
    return { upgraded: target, fromVersion: previous.packageVersion, toVersion: ORQESTRA_VERSION };
  } catch (error) {
    if (oldMoved && !newMoved) {
      try { await rename(backup, target); } catch { /* Leave the owned backup for manual recovery if the filesystem refuses rollback. */ }
    }
    if (!newMoved) await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function uninstallSkill(project: string): Promise<{ removed: string }> {
  const root = await realpath(project);
  const target = join(root, '.agents', 'skills', 'orqestra');
  for (const path of [root, join(root, '.agents'), join(root, '.agents', 'skills'), target]) await directory(path);
  await verifyOwnedInstallation(target);
  await rm(target, { recursive: true });
  // Leave .agents/skills and .agents in place; they may belong to other tools.
  return { removed: target };
}
