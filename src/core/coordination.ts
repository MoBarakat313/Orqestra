import type { TaskAssessment } from './types.js';
import type { VerificationCommand } from './execution.js';
import { parseExecutionContract } from './execution.js';
import { InputError, parseTask } from './validation.js';

export interface CoordinationPackage {
  id: string;
  objective: string;
  dependsOn: string[];
  ownedPaths: string[];
  acceptanceCriteria: string[];
  verification: VerificationCommand[];
}

export interface CoordinationContract {
  schemaVersion: 1;
  task: TaskAssessment;
  packages: CoordinationPackage[];
  verification: VerificationCommand[];
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${path} must be an object`);
  const result = value as Record<string, unknown>;
  const extra = Object.keys(result).filter(key => !keys.includes(key));
  const missing = keys.filter(key => !Object.hasOwn(result, key));
  if (extra.length || missing.length) throw new InputError(`${path}: unknown fields [${extra.join(', ')}]; missing fields [${missing.join(', ')}]`);
  return result;
}

function text(value: unknown, path: string, maximum = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new InputError(`${path} must be a nonempty string of at most ${maximum} characters without control characters`);
  }
  return value;
}

function stringList(value: unknown, path: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new InputError(`${path} must contain ${minimum} to ${maximum} entries`);
  const result = value.map((item, index) => text(item, `${path}[${index}]`, 4096));
  if (new Set(result).size !== result.length) throw new InputError(`${path} contains duplicates`);
  return result;
}

function ownedPath(value: string, path: string): string {
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\') || value.includes(':') || value.endsWith('/')
    || value.split('/').some(part => !part || part === '.' || part === '..') || value === '.git' || value.startsWith('.git/')) {
    throw new InputError(`${path} must be a normalized repository-relative path outside .git`);
  }
  return value;
}

function overlaps(left: string, right: string): boolean {
  const a = left.toLocaleLowerCase('en-US');
  const b = right.toLocaleLowerCase('en-US');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function packageOrder(contract: CoordinationContract): string[] {
  const remaining = new Map(contract.packages.map(item => [item.id, new Set(item.dependsOn)]));
  const order: string[] = [];
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, dependencies]) => [...dependencies].every(id => order.includes(id))).map(([id]) => id).sort();
    if (!ready.length) throw new InputError('coordination.packages contains a dependency cycle');
    for (const id of ready) { order.push(id); remaining.delete(id); }
  }
  return order;
}

export function parseCoordinationContract(value: unknown): CoordinationContract {
  const root = record(value, 'coordination', ['schemaVersion', 'task', 'packages', 'verification']);
  if (root.schemaVersion !== 1) throw new InputError('coordination: unsupported schema version; expected 1');
  const task = parseTask(root.task);
  if (task.ambiguity !== 'clear') throw new InputError('coordination.task.ambiguity must be clear before dispatch');
  if (task.risk !== 'low') throw new InputError('M5 coordination supports low-risk work; high-risk review execution is not implemented');
  if (!Array.isArray(root.packages) || root.packages.length < 2 || root.packages.length > 16) throw new InputError('coordination.packages must contain 2 to 16 packages');
  if (task.independentPackages !== root.packages.length) throw new InputError('coordination.task.independentPackages must equal coordination.packages length');
  const packages = root.packages.map((value, index): CoordinationPackage => {
    const path = `coordination.packages[${index}]`;
    const item = record(value, path, ['id', 'objective', 'dependsOn', 'ownedPaths', 'acceptanceCriteria', 'verification']);
    const id = text(item.id, `${path}.id`, 64);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id)) throw new InputError(`${path}.id must use lowercase letters, digits, and hyphens`);
    const objective = text(item.objective, `${path}.objective`);
    const dependsOn = stringList(item.dependsOn, `${path}.dependsOn`, 0, 15);
    const ownedPaths = stringList(item.ownedPaths, `${path}.ownedPaths`, 1, 20).map((entry, pathIndex) => ownedPath(entry, `${path}.ownedPaths[${pathIndex}]`));
    const parsed = parseExecutionContract({
      schemaVersion: 1,
      task: { objective, complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 },
      acceptanceCriteria: item.acceptanceCriteria,
      verification: item.verification,
    });
    return { id, objective, dependsOn, ownedPaths, acceptanceCriteria: parsed.acceptanceCriteria, verification: parsed.verification };
  });
  if (new Set(packages.map(item => item.id)).size !== packages.length) throw new InputError('coordination.packages contains duplicate IDs');
  const ids = new Set(packages.map(item => item.id));
  for (const item of packages) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) throw new InputError(`Package ${item.id} depends on unknown package ${dependency}`);
      if (dependency === item.id) throw new InputError(`Package ${item.id} cannot depend on itself`);
    }
  }
  for (let leftIndex = 0; leftIndex < packages.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < packages.length; rightIndex++) {
      const left = packages[leftIndex]!;
      const right = packages[rightIndex]!;
      if (left.ownedPaths.some(a => right.ownedPaths.some(b => overlaps(a, b)))) {
        throw new InputError(`Packages ${left.id} and ${right.id} have overlapping owned paths`);
      }
    }
  }
  const integration = parseExecutionContract({
    schemaVersion: 1,
    task: { objective: task.objective, complexity: 'standard', risk: 'low', ambiguity: 'clear', independentPackages: 1 },
    acceptanceCriteria: ['All declared packages are integrated'],
    verification: root.verification,
  });
  const contract = { schemaVersion: 1 as const, task, packages, verification: integration.verification };
  packageOrder(contract);
  return contract;
}

export function ownsPath(item: CoordinationPackage, path: string): boolean {
  return item.ownedPaths.some(owned => path === owned || path.startsWith(`${owned}/`));
}
