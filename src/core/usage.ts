import { InputError } from './validation.js';

export type AccountMode = 'chatgpt' | 'apiKey' | 'none' | 'other';
export type BillingMode = 'chatgpt-account' | 'api' | 'unavailable' | 'other';

export interface TokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface TurnUsage {
  status: 'measured' | 'unavailable';
  source: 'codex-app-server';
  accountMode: AccountMode;
  billingMode: BillingMode;
  tokens: TokenUsageBreakdown | null;
  threadTotal: TokenUsageBreakdown | null;
  modelContextWindow: number | null;
  gaps: string[];
}

export interface UsageSummary {
  scope: 'worker-turn' | 'durable-run' | 'coordinated-run';
  source: 'codex-app-server';
  accountMode: AccountMode | 'mixed';
  billingMode: BillingMode | 'mixed';
  attempts: { total: number; measured: number; unmeasured: number };
  tokens: TokenUsageBreakdown | null;
  cost: {
    status: 'not-applicable' | 'unavailable';
    currency: null;
    amount: null;
    reason: string;
  };
  coordinator: {
    modelTurnsStarted: 0;
    tokens: null;
    visibility: 'outside-runtime';
  };
  gaps: string[];
}

const TOKEN_KEYS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'] as const;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function token(value: unknown, path: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InputError(`${path} must be a nonnegative safe integer`);
  return value;
}

export function billingMode(accountMode: AccountMode): BillingMode {
  if (accountMode === 'chatgpt') return 'chatgpt-account';
  if (accountMode === 'apiKey') return 'api';
  if (accountMode === 'other') return 'other';
  return 'unavailable';
}

export function parseTokenUsageBreakdown(value: unknown, path = 'token usage'): TokenUsageBreakdown {
  const item = record(value, path);
  const result = {
    inputTokens: token(item.inputTokens, `${path}.inputTokens`),
    cachedInputTokens: token(item.cachedInputTokens, `${path}.cachedInputTokens`),
    cacheWriteInputTokens: token(item.cacheWriteInputTokens, `${path}.cacheWriteInputTokens`, 0),
    outputTokens: token(item.outputTokens, `${path}.outputTokens`),
    reasoningOutputTokens: token(item.reasoningOutputTokens, `${path}.reasoningOutputTokens`),
    totalTokens: token(item.totalTokens, `${path}.totalTokens`),
  };
  if (result.cachedInputTokens > result.inputTokens) throw new InputError(`${path}.cachedInputTokens cannot exceed inputTokens`);
  if (result.reasoningOutputTokens > result.outputTokens) throw new InputError(`${path}.reasoningOutputTokens cannot exceed outputTokens`);
  return result;
}

export function parseTurnUsageNotification(value: unknown, accountMode: AccountMode, threadId: string, turnId: string): TurnUsage | null {
  const body = record(value, 'thread/tokenUsage/updated');
  if (body.threadId !== threadId || body.turnId !== turnId) return null;
  const usage = record(body.tokenUsage, 'thread/tokenUsage/updated.tokenUsage');
  const context = usage.modelContextWindow;
  if (context !== null && (typeof context !== 'number' || !Number.isSafeInteger(context) || context < 1)) {
    throw new InputError('thread/tokenUsage/updated.modelContextWindow must be null or a positive safe integer');
  }
  return {
    status: 'measured', source: 'codex-app-server', accountMode, billingMode: billingMode(accountMode),
    tokens: parseTokenUsageBreakdown(usage.last, 'thread/tokenUsage/updated.last'),
    threadTotal: parseTokenUsageBreakdown(usage.total, 'thread/tokenUsage/updated.total'),
    modelContextWindow: context,
    gaps: [],
  };
}

export function unavailableTurnUsage(accountMode: AccountMode, reason: string): TurnUsage {
  return {
    status: 'unavailable', source: 'codex-app-server', accountMode, billingMode: billingMode(accountMode),
    tokens: null, threadTotal: null, modelContextWindow: null, gaps: [reason],
  };
}

export function attributeTurnUsage(snapshot: TurnUsage, baseline: TokenUsageBreakdown | null, freshThread: boolean): TurnUsage {
  if (snapshot.status !== 'measured' || !snapshot.tokens || !snapshot.threadTotal) return snapshot;
  if (freshThread) return { ...snapshot, tokens: snapshot.threadTotal };
  if (!baseline) return {
    ...snapshot,
    gaps: [...snapshot.gaps, 'The resumed thread did not replay a pre-turn cumulative snapshot; reported tokens cover only the final model response and may omit continuations.'],
  };
  const delta = emptyTokens();
  for (const key of TOKEN_KEYS) {
    if (snapshot.threadTotal[key] < baseline[key]) return {
      ...snapshot,
      gaps: [...snapshot.gaps, 'Cumulative thread usage moved backwards; reported tokens use the final model response instead of an invalid delta.'],
    };
    delta[key] = snapshot.threadTotal[key] - baseline[key];
  }
  return { ...snapshot, tokens: delta };
}

function emptyTokens(): TokenUsageBreakdown {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

export function addTokens(left: TokenUsageBreakdown, right: TokenUsageBreakdown): TokenUsageBreakdown {
  const result = emptyTokens();
  for (const key of TOKEN_KEYS) {
    const sum = left[key] + right[key];
    if (!Number.isSafeInteger(sum)) throw new InputError('Aggregated token usage exceeds the safe integer limit');
    result[key] = sum;
  }
  return result;
}

export function validTurnUsage(value: unknown): value is TurnUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as TurnUsage;
  if (!['measured', 'unavailable'].includes(item.status) || item.source !== 'codex-app-server'
    || !['chatgpt', 'apiKey', 'none', 'other'].includes(item.accountMode)
    || !['chatgpt-account', 'api', 'unavailable', 'other'].includes(item.billingMode)
    || item.billingMode !== billingMode(item.accountMode)
    || !Array.isArray(item.gaps) || item.gaps.some(gap => typeof gap !== 'string' || !gap || gap.length > 500)) return false;
  try {
    if (item.tokens !== null) parseTokenUsageBreakdown(item.tokens);
    if (item.threadTotal !== null) parseTokenUsageBreakdown(item.threadTotal);
  } catch { return false; }
  return (item.status === 'measured') === (item.tokens !== null && item.threadTotal !== null)
    && (item.modelContextWindow === null || (Number.isSafeInteger(item.modelContextWindow) && item.modelContextWindow > 0));
}

export function validUsageSummary(value: unknown): value is UsageSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as UsageSummary;
  if (!['worker-turn', 'durable-run', 'coordinated-run'].includes(item.scope) || item.source !== 'codex-app-server'
    || !['chatgpt', 'apiKey', 'none', 'other', 'mixed'].includes(item.accountMode)
    || !['chatgpt-account', 'api', 'unavailable', 'other', 'mixed'].includes(item.billingMode)
    || !item.attempts || !Number.isSafeInteger(item.attempts.total) || !Number.isSafeInteger(item.attempts.measured)
    || !Number.isSafeInteger(item.attempts.unmeasured) || item.attempts.total < 0 || item.attempts.measured < 0
    || item.attempts.total > 100
    || item.attempts.unmeasured < 0 || item.attempts.measured + item.attempts.unmeasured !== item.attempts.total
    || !item.cost || !['not-applicable', 'unavailable'].includes(item.cost.status) || item.cost.currency !== null
    || item.cost.amount !== null || typeof item.cost.reason !== 'string' || !item.coordinator
    || item.coordinator.modelTurnsStarted !== 0 || item.coordinator.tokens !== null || item.coordinator.visibility !== 'outside-runtime'
    || !Array.isArray(item.gaps) || item.gaps.some(gap => typeof gap !== 'string' || !gap || gap.length > 500)) return false;
  if (item.accountMode !== 'mixed' && item.billingMode !== billingMode(item.accountMode)) return false;
  try { if (item.tokens !== null) parseTokenUsageBreakdown(item.tokens); } catch { return false; }
  return (item.attempts.measured > 0) === (item.tokens !== null);
}

export function summarizeUsage(scope: UsageSummary['scope'], attempts: TurnUsage[]): UsageSummary {
  const measured = attempts.filter(item => item.status === 'measured' && item.tokens !== null);
  const modes = new Set(attempts.map(item => item.accountMode));
  const accountMode = modes.size === 1 ? attempts[0]!.accountMode : modes.size ? 'mixed' : 'none';
  const billings = new Set(attempts.map(item => item.billingMode));
  const billed = billings.size === 1 ? attempts[0]!.billingMode : billings.size ? 'mixed' : 'unavailable';
  const tokens = measured.length ? measured.reduce((sum, item) => addTokens(sum, item.tokens!), emptyTokens()) : null;
  const gaps = [...new Set([
    ...attempts.flatMap(item => item.gaps),
    ...(measured.length < attempts.length ? [`${attempts.length - measured.length} of ${attempts.length} worker turns lack final token telemetry.`] : []),
    'The main Codex conversation is outside the helper runtime, so its coordinator tokens are not visible to Orqestra.',
  ])];
  const api = billed === 'api';
  return {
    scope, source: 'codex-app-server', accountMode, billingMode: billed,
    attempts: { total: attempts.length, measured: measured.length, unmeasured: attempts.length - measured.length },
    tokens,
    cost: api
      ? { status: 'unavailable', currency: null, amount: null, reason: 'App Server token telemetry does not include a billed amount or versioned price snapshot.' }
      : { status: billed === 'chatgpt-account' ? 'not-applicable' : 'unavailable', currency: null, amount: null, reason: billed === 'chatgpt-account' ? 'ChatGPT account usage is not converted to API dollars.' : 'No attributable billing data is available for this account mode.' },
    coordinator: { modelTurnsStarted: 0, tokens: null, visibility: 'outside-runtime' },
    gaps,
  };
}

export function combineUsageSummaries(scope: UsageSummary['scope'], summaries: UsageSummary[]): UsageSummary {
  const accountModes = new Set(summaries.map(item => item.accountMode));
  const accountMode = accountModes.size === 1 ? summaries[0]!.accountMode : accountModes.size ? 'mixed' : 'none';
  const billingModes = new Set(summaries.map(item => item.billingMode));
  const billed = billingModes.size === 1 ? summaries[0]!.billingMode : billingModes.size ? 'mixed' : 'unavailable';
  const totals = summaries.reduce((counts, item) => ({
    total: counts.total + item.attempts.total,
    measured: counts.measured + item.attempts.measured,
    unmeasured: counts.unmeasured + item.attempts.unmeasured,
  }), { total: 0, measured: 0, unmeasured: 0 });
  const observed = summaries.map(item => item.tokens).filter((item): item is TokenUsageBreakdown => item !== null);
  const tokens = observed.length ? observed.reduce(addTokens, emptyTokens()) : null;
  const gaps = [...new Set([
    ...summaries.flatMap(item => item.gaps.filter(gap => !gap.startsWith('The main Codex conversation'))),
    ...(totals.unmeasured ? [`${totals.unmeasured} of ${totals.total} worker turns lack final token telemetry.`] : []),
    'The main Codex conversation is outside the helper runtime, so its coordinator tokens are not visible to Orqestra.',
  ])];
  return {
    scope, source: 'codex-app-server', accountMode, billingMode: billed, attempts: totals, tokens,
    cost: billed === 'api'
      ? { status: 'unavailable', currency: null, amount: null, reason: 'App Server token telemetry does not include a billed amount or versioned price snapshot.' }
      : { status: billed === 'chatgpt-account' ? 'not-applicable' : 'unavailable', currency: null, amount: null, reason: billed === 'chatgpt-account' ? 'ChatGPT account usage is not converted to API dollars.' : 'No attributable billing data is available for this account mode.' },
    coordinator: { modelTurnsStarted: 0, tokens: null, visibility: 'outside-runtime' }, gaps,
  };
}
