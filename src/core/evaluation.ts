import { parseTokenUsageBreakdown, type AccountMode, type TokenUsageBreakdown } from './usage.js';
import { InputError } from './validation.js';

export interface BenchmarkModelUsage {
  model: string;
  reasoning: string;
  turns: number;
  measuredTurns: number;
  tokens: TokenUsageBreakdown | null;
}

export interface BenchmarkObservation {
  source: 'direct-codex' | 'orqestra';
  observedAt: string;
  status: 'succeeded' | 'failed';
  verification: { passed: number; total: number };
  regressions: number;
  retries: number;
  elapsedMs: number;
  usage: {
    accountMode: AccountMode;
    tokens: TokenUsageBreakdown | null;
    apiCostUsd: number | null;
    models: BenchmarkModelUsage[];
  };
}

export interface BenchmarkTrial {
  id: string;
  taskId: string;
  contractSha256: string;
  baseCommit: string;
  direct: BenchmarkObservation | null;
  orqestra: BenchmarkObservation | null;
}

export interface BenchmarkInput {
  schemaVersion: 1 | 2;
  benchmarkId: string;
  trials: BenchmarkTrial[];
}

export interface BenchmarkReport {
  schemaVersion: 2;
  mode: 'benchmark-evaluation';
  benchmarkId: string;
  trials: { total: number; executedPairs: number; incompletePairs: number; tokenMeasuredPairs: number; apiCostMeasuredPairs: number };
  completion: { directSucceeded: number; orqestraSucceeded: number };
  verification: { directPassed: number; directTotal: number; orqestraPassed: number; orqestraTotal: number };
  regressions: { direct: number; orqestra: number };
  retries: { direct: number; orqestra: number };
  elapsedMs: { direct: number; orqestra: number; difference: number };
  tokens: { direct: TokenUsageBreakdown; orqestra: TokenUsageBreakdown; difference: TokenUsageBreakdown } | null;
  models: { direct: BenchmarkModelUsage[]; orqestra: BenchmarkModelUsage[] };
  apiCostUsd: { direct: number; orqestra: number; difference: number } | null;
  warnings: string[];
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${path} must be an object`);
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => !keys.includes(key));
  const missing = keys.filter(key => !Object.hasOwn(item, key));
  if (extra.length || missing.length) throw new InputError(`${path}: unknown fields [${extra.join(', ')}]; missing fields [${missing.join(', ')}]`);
  return item;
}

function text(value: unknown, path: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new InputError(`${path} must be a nonempty bounded string`);
  return value;
}

function integer(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new InputError(`${path} must be a nonnegative safe integer`);
  return value;
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) throw new InputError(`${path} must be a UTC ISO timestamp`);
  return result;
}

function modelUsage(value: unknown, path: string): BenchmarkModelUsage {
  const item = object(value, path, ['model', 'reasoning', 'turns', 'measuredTurns', 'tokens']);
  const turns = integer(item.turns, `${path}.turns`, 100);
  const measuredTurns = integer(item.measuredTurns, `${path}.measuredTurns`, turns);
  const tokens = item.tokens === null ? null : parseTokenUsageBreakdown(item.tokens, `${path}.tokens`);
  if ((measuredTurns === 0) !== (tokens === null)) throw new InputError(`${path}.tokens must be present exactly when measuredTurns is positive`);
  return { model: text(item.model, `${path}.model`), reasoning: text(item.reasoning, `${path}.reasoning`), turns, measuredTurns, tokens };
}

function observation(value: unknown, path: string, source: BenchmarkObservation['source'], schemaVersion: 1 | 2): BenchmarkObservation | null {
  if (value === null) return null;
  const item = object(value, path, ['source', 'observedAt', 'status', 'verification', 'regressions', 'retries', 'elapsedMs', 'usage']);
  if (item.source !== source) throw new InputError(`${path}.source must be ${source}`);
  if (item.status !== 'succeeded' && item.status !== 'failed') throw new InputError(`${path}.status must be succeeded or failed`);
  const verification = object(item.verification, `${path}.verification`, ['passed', 'total']);
  const total = integer(verification.total, `${path}.verification.total`, 1000);
  const passed = integer(verification.passed, `${path}.verification.passed`, total);
  const regressions = integer(item.regressions, `${path}.regressions`, 1000);
  if (item.status === 'succeeded' && (passed !== total || regressions !== 0)) throw new InputError(`${path}: succeeded requires all checks to pass and zero regressions`);
  const usage = object(item.usage, `${path}.usage`, schemaVersion === 2 ? ['accountMode', 'tokens', 'apiCostUsd', 'models'] : ['accountMode', 'tokens', 'apiCostUsd']);
  if (!['chatgpt', 'apiKey', 'none', 'other'].includes(String(usage.accountMode))) throw new InputError(`${path}.usage.accountMode is invalid`);
  let apiCostUsd: number | null = null;
  if (usage.apiCostUsd !== null) {
    if (typeof usage.apiCostUsd !== 'number' || !Number.isFinite(usage.apiCostUsd) || usage.apiCostUsd < 0) throw new InputError(`${path}.usage.apiCostUsd must be null or a nonnegative number`);
    if (usage.accountMode !== 'apiKey') throw new InputError(`${path}.usage.apiCostUsd is valid only for API-key observations`);
    apiCostUsd = usage.apiCostUsd;
  }
  const models = schemaVersion === 1 ? [] : (() => {
    if (!Array.isArray(usage.models) || !usage.models.length || usage.models.length > 100) throw new InputError(`${path}.usage.models must contain 1 to 100 entries`);
    const rows = usage.models.map((raw, index) => modelUsage(raw, `${path}.usage.models[${index}]`));
    const identities = new Set(rows.map(row => `${row.model}\0${row.reasoning}`));
    if (identities.size !== rows.length) throw new InputError(`${path}.usage.models contains duplicate model and reasoning entries`);
    return rows;
  })();
  const tokens = usage.tokens === null ? null : parseTokenUsageBreakdown(usage.tokens, `${path}.usage.tokens`);
  if (schemaVersion === 2) {
    const rows = models.map(row => row.tokens).filter((row): row is TokenUsageBreakdown => row !== null);
    const modelTokens = rows.length ? sumTokenRows(rows) : null;
    if ((tokens === null) !== (modelTokens === null)) throw new InputError(`${path}.usage.tokens must match the measured per-model usage`);
    if (tokens && modelTokens && Object.keys(tokens).some(key => tokens[key as keyof TokenUsageBreakdown] !== modelTokens[key as keyof TokenUsageBreakdown])) {
      throw new InputError(`${path}.usage.tokens must equal the measured per-model token sum`);
    }
  }
  return {
    source, observedAt: timestamp(item.observedAt, `${path}.observedAt`), status: item.status,
    verification: { passed, total }, regressions,
    retries: integer(item.retries, `${path}.retries`, 100), elapsedMs: integer(item.elapsedMs, `${path}.elapsedMs`),
    usage: {
      accountMode: usage.accountMode as AccountMode,
      tokens,
      apiCostUsd,
      models,
    },
  };
}

export function parseBenchmark(value: unknown): BenchmarkInput {
  const root = object(value, 'benchmark', ['schemaVersion', 'benchmarkId', 'trials']);
  if (root.schemaVersion !== 1 && root.schemaVersion !== 2) throw new InputError('benchmark: unsupported schema version; expected 1 or 2');
  const schemaVersion = root.schemaVersion;
  if (!Array.isArray(root.trials) || !root.trials.length || root.trials.length > 100) throw new InputError('benchmark.trials must contain 1 to 100 trials');
  const ids = new Set<string>();
  const conditions = new Map<string, string>();
  const trials = root.trials.map((raw, index): BenchmarkTrial => {
    const path = `benchmark.trials[${index}]`;
    const item = object(raw, path, ['id', 'taskId', 'contractSha256', 'baseCommit', 'direct', 'orqestra']);
    const id = text(item.id, `${path}.id`);
    if (ids.has(id)) throw new InputError(`benchmark has duplicate trial id ${id}`);
    ids.add(id);
    const taskId = text(item.taskId, `${path}.taskId`);
    const contractSha256 = text(item.contractSha256, `${path}.contractSha256`);
    if (!/^[a-f0-9]{64}$/u.test(contractSha256)) throw new InputError(`${path}.contractSha256 must be a lowercase SHA-256 digest`);
    const baseCommit = text(item.baseCommit, `${path}.baseCommit`);
    if (!/^[a-f0-9]{40,64}$/u.test(baseCommit)) throw new InputError(`${path}.baseCommit must be a lowercase Git object ID`);
    const condition = JSON.stringify([contractSha256, baseCommit]);
    if (conditions.has(taskId) && conditions.get(taskId) !== condition) throw new InputError(`task ${taskId} does not use one reproducible contract and base commit`);
    conditions.set(taskId, condition);
    return {
      id, taskId, contractSha256, baseCommit,
      direct: observation(item.direct, `${path}.direct`, 'direct-codex', schemaVersion),
      orqestra: observation(item.orqestra, `${path}.orqestra`, 'orqestra', schemaVersion),
    };
  });
  return { schemaVersion, benchmarkId: text(root.benchmarkId, 'benchmark.benchmarkId'), trials };
}

function zeroTokens(): TokenUsageBreakdown {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

function sumTokenRows(rows: TokenUsageBreakdown[]): TokenUsageBreakdown {
  const total = zeroTokens();
  for (const row of rows) for (const key of Object.keys(total) as Array<keyof TokenUsageBreakdown>) total[key] += row[key];
  return total;
}

function tokenDifference(direct: TokenUsageBreakdown, orqestra: TokenUsageBreakdown): TokenUsageBreakdown {
  const result = zeroTokens();
  for (const key of Object.keys(result) as Array<keyof TokenUsageBreakdown>) result[key] = orqestra[key] - direct[key];
  return result;
}

function completeModelUsage(observation: BenchmarkObservation): boolean {
  return observation.usage.models.length > 0 && observation.usage.models.every(row => row.turns === row.measuredTurns);
}

function aggregateModels(observations: BenchmarkObservation[]): BenchmarkModelUsage[] {
  const groups = new Map<string, BenchmarkModelUsage>();
  for (const observation of observations) for (const row of observation.usage.models) {
    const key = `${row.model}\0${row.reasoning}`;
    const current = groups.get(key) ?? { model: row.model, reasoning: row.reasoning, turns: 0, measuredTurns: 0, tokens: null };
    current.turns += row.turns;
    current.measuredTurns += row.measuredTurns;
    if (row.tokens) current.tokens = current.tokens ? addTokenRows(current.tokens, row.tokens) : { ...row.tokens };
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => left.model.localeCompare(right.model) || left.reasoning.localeCompare(right.reasoning));
}

function addTokenRows(left: TokenUsageBreakdown, right: TokenUsageBreakdown): TokenUsageBreakdown {
  const result = zeroTokens();
  for (const key of Object.keys(result) as Array<keyof TokenUsageBreakdown>) {
    const value = left[key] + right[key];
    if (!Number.isSafeInteger(value)) throw new InputError('Aggregated model usage exceeds the safe integer limit');
    result[key] = value;
  }
  return result;
}

export function evaluateBenchmark(input: BenchmarkInput): BenchmarkReport {
  const pairs = input.trials.filter((trial): trial is BenchmarkTrial & { direct: BenchmarkObservation; orqestra: BenchmarkObservation } => Boolean(trial.direct && trial.orqestra));
  const tokenPairs = pairs.filter(pair => pair.direct.usage.tokens !== null && pair.orqestra.usage.tokens !== null
    && (input.schemaVersion === 1 || (completeModelUsage(pair.direct) && completeModelUsage(pair.orqestra))));
  const costPairs = pairs.filter(pair => pair.direct.usage.apiCostUsd !== null && pair.orqestra.usage.apiCostUsd !== null);
  const directTokens = sumTokenRows(tokenPairs.map(pair => pair.direct.usage.tokens!));
  const orqestraTokens = sumTokenRows(tokenPairs.map(pair => pair.orqestra.usage.tokens!));
  const directCost = costPairs.reduce((sum, pair) => sum + pair.direct.usage.apiCostUsd!, 0);
  const orqestraCost = costPairs.reduce((sum, pair) => sum + pair.orqestra.usage.apiCostUsd!, 0);
  return {
    schemaVersion: 2, mode: 'benchmark-evaluation', benchmarkId: input.benchmarkId,
    trials: { total: input.trials.length, executedPairs: pairs.length, incompletePairs: input.trials.length - pairs.length, tokenMeasuredPairs: tokenPairs.length, apiCostMeasuredPairs: costPairs.length },
    completion: { directSucceeded: pairs.filter(pair => pair.direct.status === 'succeeded').length, orqestraSucceeded: pairs.filter(pair => pair.orqestra.status === 'succeeded').length },
    verification: {
      directPassed: pairs.reduce((sum, pair) => sum + pair.direct.verification.passed, 0), directTotal: pairs.reduce((sum, pair) => sum + pair.direct.verification.total, 0),
      orqestraPassed: pairs.reduce((sum, pair) => sum + pair.orqestra.verification.passed, 0), orqestraTotal: pairs.reduce((sum, pair) => sum + pair.orqestra.verification.total, 0),
    },
    regressions: { direct: pairs.reduce((sum, pair) => sum + pair.direct.regressions, 0), orqestra: pairs.reduce((sum, pair) => sum + pair.orqestra.regressions, 0) },
    retries: { direct: pairs.reduce((sum, pair) => sum + pair.direct.retries, 0), orqestra: pairs.reduce((sum, pair) => sum + pair.orqestra.retries, 0) },
    elapsedMs: {
      direct: pairs.reduce((sum, pair) => sum + pair.direct.elapsedMs, 0), orqestra: pairs.reduce((sum, pair) => sum + pair.orqestra.elapsedMs, 0),
      difference: pairs.reduce((sum, pair) => sum + pair.orqestra.elapsedMs - pair.direct.elapsedMs, 0),
    },
    tokens: tokenPairs.length ? { direct: directTokens, orqestra: orqestraTokens, difference: tokenDifference(directTokens, orqestraTokens) } : null,
    models: { direct: aggregateModels(pairs.map(pair => pair.direct)), orqestra: aggregateModels(pairs.map(pair => pair.orqestra)) },
    apiCostUsd: costPairs.length ? { direct: directCost, orqestra: orqestraCost, difference: orqestraCost - directCost } : null,
    warnings: [
      'Differences use executed pairs only; negative values mean Orqestra used less than direct Codex within those pairs.',
      'Incomplete trials and pairs without matching measured usage are excluded from the corresponding difference.',
      'Schema 2 token differences require complete per-model turn coverage for both arms.',
      'The evaluator validates evidence structure and shared starting conditions; it does not independently attest caller-recorded observations.',
      'No unexecuted counterfactual is reported as savings.',
    ],
  };
}
