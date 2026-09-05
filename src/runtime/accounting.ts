import { billingMode, type AccountMode, type BillingMode } from '../core/usage.js';
import { diagnose } from './doctor.js';
import { executableCommand } from './executable.js';
import { ProtocolError, StdioClient } from './stdio-client.js';

interface RpcPeer {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string): void;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitBucket {
  limitId: string;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

export interface AccountUsageReport {
  schemaVersion: 1;
  mode: 'account-usage';
  observedAt: string;
  codexVersion: string;
  accountMode: AccountMode;
  billingMode: BillingMode;
  status: 'available' | 'partial' | 'unavailable';
  chatgpt: {
    rateLimits: RateLimitBucket[] | null;
    tokenActivity: {
      lifetimeTokens: number | null;
      peakDailyTokens: number | null;
      longestRunningTurnSec: number | null;
      currentStreakDays: number | null;
      longestStreakDays: number | null;
      dailyUsageBuckets: Array<{ startDate: string; tokens: number }> | null;
    } | null;
  } | null;
  api: {
    organizationUsage: null;
    cost: null;
    reason: string;
  } | null;
  warnings: string[];
  modelTurnsStarted: 0;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function safeText(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new ProtocolError(`Invalid ${label}`);
  return value;
}

function optionalInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ProtocolError(`Invalid ${label}`);
  return value;
}

function accountMode(value: unknown): AccountMode {
  if (value === null) return 'none';
  const account = record(value, 'account/read account');
  const type = safeText(account.type, 'account type');
  if (type === 'chatgpt') return 'chatgpt';
  if (type === 'apiKey') return 'apiKey';
  return 'other';
}

function window(value: unknown, label: string): RateLimitWindow | null {
  if (value === null || value === undefined) return null;
  const item = record(value, label);
  if (typeof item.usedPercent !== 'number' || !Number.isFinite(item.usedPercent) || item.usedPercent < 0 || item.usedPercent > 100) {
    throw new ProtocolError(`Invalid ${label}.usedPercent`);
  }
  return {
    usedPercent: item.usedPercent,
    windowDurationMins: optionalInteger(item.windowDurationMins, `${label}.windowDurationMins`),
    resetsAt: optionalInteger(item.resetsAt, `${label}.resetsAt`),
  };
}

function bucket(value: unknown, fallbackId?: string): RateLimitBucket {
  const item = record(value, 'rate-limit bucket');
  const id = item.limitId === undefined && fallbackId ? fallbackId : safeText(item.limitId, 'rate-limit limitId');
  return {
    limitId: id!,
    limitName: safeText(item.limitName ?? null, 'rate-limit limitName', true),
    primary: window(item.primary, 'rate-limit primary'),
    secondary: window(item.secondary, 'rate-limit secondary'),
  };
}

function rateLimits(value: unknown): RateLimitBucket[] {
  const result = record(value, 'account/rateLimits/read response');
  const byId = result.rateLimitsByLimitId;
  if (byId && typeof byId === 'object' && !Array.isArray(byId)) {
    const entries = Object.entries(byId as Record<string, unknown>);
    if (entries.length > 100) throw new ProtocolError('Too many rate-limit buckets');
    return entries.map(([id, value]) => bucket(value, safeText(id, 'rate-limit key')!));
  }
  if (result.rateLimits === null || result.rateLimits === undefined) return [];
  return [bucket(result.rateLimits)];
}

function accountTokenActivity(value: unknown): NonNullable<NonNullable<AccountUsageReport['chatgpt']>['tokenActivity']> {
  const result = record(value, 'account/usage/read response');
  const summary = record(result.summary, 'account usage summary');
  let dailyUsageBuckets: Array<{ startDate: string; tokens: number }> | null = null;
  if (result.dailyUsageBuckets !== null && result.dailyUsageBuckets !== undefined) {
    if (!Array.isArray(result.dailyUsageBuckets) || result.dailyUsageBuckets.length > 400) throw new ProtocolError('Invalid account daily usage buckets');
    dailyUsageBuckets = result.dailyUsageBuckets.map((raw, index) => {
      const item = record(raw, `daily usage bucket ${index}`);
      const startDate = safeText(item.startDate, `daily usage bucket ${index} startDate`)!;
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(startDate)) throw new ProtocolError('Invalid account daily usage date');
      const tokens = optionalInteger(item.tokens, `daily usage bucket ${index} tokens`);
      if (tokens === null) throw new ProtocolError('Invalid account daily usage tokens');
      return { startDate, tokens };
    });
  }
  return {
    lifetimeTokens: optionalInteger(summary.lifetimeTokens, 'account usage lifetimeTokens'),
    peakDailyTokens: optionalInteger(summary.peakDailyTokens, 'account usage peakDailyTokens'),
    longestRunningTurnSec: optionalInteger(summary.longestRunningTurnSec, 'account usage longestRunningTurnSec'),
    currentStreakDays: optionalInteger(summary.currentStreakDays, 'account usage currentStreakDays'),
    longestStreakDays: optionalInteger(summary.longestStreakDays, 'account usage longestStreakDays'),
    dailyUsageBuckets,
  };
}

/** Read account-level observations without starting a model turn. */
export async function readAccountUsage(peer: RpcPeer, codexVersion: string): Promise<AccountUsageReport> {
  record(await peer.request('initialize', { clientInfo: { name: 'orqestra', title: 'Orqestra', version: '0.1.0-dev.0' } }), 'initialize response');
  peer.notify('initialized');
  const auth = record(await peer.request('account/read', { refreshToken: false }), 'account/read response');
  if (!Object.hasOwn(auth, 'account') || typeof auth.requiresOpenaiAuth !== 'boolean') throw new ProtocolError('account/read lacks account state');
  const mode = accountMode(auth.account);
  const base = {
    schemaVersion: 1 as const, mode: 'account-usage' as const, observedAt: new Date().toISOString(), codexVersion,
    accountMode: mode, billingMode: billingMode(mode), modelTurnsStarted: 0 as const,
  };
  if (mode === 'apiKey') return {
    ...base, status: 'unavailable', chatgpt: null,
    api: { organizationUsage: null, cost: null, reason: 'Codex App Server does not expose organization API usage or billed cost for API-key sessions.' },
    warnings: ['API usage and cost require separately authorized API organization data; ChatGPT account metrics were not requested.'],
  };
  if (mode !== 'chatgpt') return {
    ...base, status: 'unavailable', chatgpt: null, api: null,
    warnings: ['Account-level usage is unavailable for the reported authentication mode.'],
  };
  let limits: RateLimitBucket[] | null = null;
  let activity: NonNullable<NonNullable<AccountUsageReport['chatgpt']>['tokenActivity']> | null = null;
  const warnings = [
    'ChatGPT rate-limit and token-activity observations are account-wide and cannot be attributed to this Orqestra run.',
    'ChatGPT account observations are not converted to API dollars.',
  ];
  try { limits = rateLimits(await peer.request('account/rateLimits/read', {})); }
  catch { warnings.push('ChatGPT rate-limit data was unavailable or incompatible.'); }
  try { activity = accountTokenActivity(await peer.request('account/usage/read', {})); }
  catch { warnings.push('ChatGPT token-activity data was unavailable or incompatible.'); }
  return {
    ...base, status: limits && activity ? 'available' : limits || activity ? 'partial' : 'unavailable',
    chatgpt: { rateLimits: limits, tokenActivity: activity }, api: null, warnings,
  };
}

export async function inspectAccountUsage(executable = 'codex'): Promise<AccountUsageReport> {
  const diagnostic = await diagnose(executable);
  if (!diagnostic.ready) throw new ProtocolError('Codex prerequisites are not met. Run orqestra doctor --codex <executable> for details.');
  const { command, prefix } = executableCommand(executable);
  const client = new StdioClient(command, [...prefix, 'app-server']);
  try { return await readAccountUsage(client, diagnostic.codex.version!); }
  finally { await client.close(); }
}

