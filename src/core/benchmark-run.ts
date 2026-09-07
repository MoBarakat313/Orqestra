import { parseExecutionContract, parseVerificationCommands, type ExecutionContract, type VerificationCommand } from './execution.js';
import { InputError } from './validation.js';

export interface BenchmarkRunSpec {
  schemaVersion: 1;
  benchmarkId: string;
  taskId: string;
  repetitions: number;
  order: 'alternating' | 'direct-first' | 'orqestra-first';
  preparation: VerificationCommand[];
  execution: ExecutionContract;
  direct: { model: string | null; reasoning: string | null };
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${path} must be an object`);
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => !keys.includes(key));
  const missing = keys.filter(key => !Object.hasOwn(item, key));
  if (extra.length || missing.length) throw new InputError(`${path}: unknown fields [${extra.join(', ')}]; missing fields [${missing.join(', ')}]`);
  return item;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(value)) {
    throw new InputError(`${path} must use 1 to 100 lowercase letters, numbers, dots, underscores, or hyphens`);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new InputError(`${path} must be null or a nonempty string of at most 200 characters without control characters`);
  }
  return value;
}

export function parseBenchmarkRunSpec(value: unknown): BenchmarkRunSpec {
  const root = record(value, 'benchmark run', ['schemaVersion', 'benchmarkId', 'taskId', 'repetitions', 'order', 'preparation', 'execution', 'direct']);
  if (root.schemaVersion !== 1) throw new InputError('benchmark run: unsupported schema version; expected 1');
  if (!Number.isSafeInteger(root.repetitions) || Number(root.repetitions) < 1 || Number(root.repetitions) > 20) {
    throw new InputError('benchmark run.repetitions must be an integer between 1 and 20');
  }
  if (!['alternating', 'direct-first', 'orqestra-first'].includes(String(root.order))) {
    throw new InputError('benchmark run.order must be alternating, direct-first, or orqestra-first');
  }
  const direct = record(root.direct, 'benchmark run.direct', ['model', 'reasoning']);
  const model = nullableText(direct.model, 'benchmark run.direct.model');
  const reasoning = nullableText(direct.reasoning, 'benchmark run.direct.reasoning');
  if ((model === null) !== (reasoning === null)) throw new InputError('benchmark run.direct.model and reasoning must both be null or both be strings');
  return {
    schemaVersion: 1,
    benchmarkId: identifier(root.benchmarkId, 'benchmark run.benchmarkId'),
    taskId: identifier(root.taskId, 'benchmark run.taskId'),
    repetitions: Number(root.repetitions),
    order: root.order as BenchmarkRunSpec['order'],
    preparation: parseVerificationCommands(root.preparation, 'benchmark run.preparation', 0, 10),
    execution: parseExecutionContract(root.execution),
    direct: { model, reasoning },
  };
}
