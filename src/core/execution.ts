import type { TaskAssessment } from './types.js';
import { InputError, parseTask } from './validation.js';

export interface VerificationCommand {
  name: string;
  command: string[];
  timeoutSeconds: number;
}

export interface ExecutionContract {
  schemaVersion: 1;
  task: TaskAssessment;
  acceptanceCriteria: string[];
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

function boundedText(value: unknown, path: string, maximum = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new InputError(`${path} must be a nonempty string of at most ${maximum} characters without control characters`);
  }
  return value;
}

export function parseExecutionContract(value: unknown): ExecutionContract {
  const root = record(value, 'execution', ['schemaVersion', 'task', 'acceptanceCriteria', 'verification']);
  if (root.schemaVersion !== 1) throw new InputError('execution: unsupported schema version; expected 1');
  if (!Array.isArray(root.acceptanceCriteria) || !root.acceptanceCriteria.length || root.acceptanceCriteria.length > 20) {
    throw new InputError('execution.acceptanceCriteria must contain 1 to 20 entries');
  }
  const acceptanceCriteria = root.acceptanceCriteria.map((item, index) => boundedText(item, `execution.acceptanceCriteria[${index}]`));
  if (new Set(acceptanceCriteria).size !== acceptanceCriteria.length) throw new InputError('execution.acceptanceCriteria contains duplicates');
  if (!Array.isArray(root.verification) || !root.verification.length || root.verification.length > 10) {
    throw new InputError('execution.verification must contain 1 to 10 commands');
  }
  const verification = root.verification.map((value, index): VerificationCommand => {
    const item = record(value, `execution.verification[${index}]`, ['name', 'command', 'timeoutSeconds']);
    if (!Array.isArray(item.command) || !item.command.length || item.command.length > 32) {
      throw new InputError(`execution.verification[${index}].command must contain 1 to 32 arguments`);
    }
    if (typeof item.timeoutSeconds !== 'number' || !Number.isSafeInteger(item.timeoutSeconds) || item.timeoutSeconds < 1 || item.timeoutSeconds > 600) {
      throw new InputError(`execution.verification[${index}].timeoutSeconds must be an integer between 1 and 600`);
    }
    return {
      name: boundedText(item.name, `execution.verification[${index}].name`, 120),
      command: item.command.map((part, partIndex) => boundedText(part, `execution.verification[${index}].command[${partIndex}]`, 4096)),
      timeoutSeconds: item.timeoutSeconds,
    };
  });
  return { schemaVersion: 1, task: parseTask(root.task), acceptanceCriteria, verification };
}
