import type { Catalog, Config } from '../core/types.js';
import { parseCatalog } from '../core/validation.js';
import { diagnose } from './doctor.js';
import { executableCommand } from './executable.js';
import { ProtocolError, StdioClient } from './stdio-client.js';

interface RpcPeer {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string): void;
}

export interface DiscoveryReport {
  mode: 'codex-discovery';
  observedAt: string;
  codexVersion: string;
  account: { mode: 'chatgpt' | 'apiKey' | 'none' | 'other'; requiresOpenaiAuth: boolean };
  models: Array<{ id: string; displayName: string; reasoningEfforts: string[] }>;
  warnings: string[];
  modelTurnsStarted: 0;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError(`Invalid ${label} response`);
  return value as Record<string, unknown>;
}

function safeString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ProtocolError(`Invalid ${label} in Codex response`);
  }
  return value;
}

/** Only initialize, account/read, and model/list are sent by this operation. */
export async function readDiscovery(peer: RpcPeer, codexVersion: string): Promise<DiscoveryReport> {
  record(await peer.request('initialize', { clientInfo: { name: 'orqestra', title: 'Orqestra', version: '0.1.0-dev.0' } }), 'initialize');
  peer.notify('initialized');
  const auth = record(await peer.request('account/read', { refreshToken: false }), 'account/read');
  if (typeof auth.requiresOpenaiAuth !== 'boolean') throw new ProtocolError('account/read lacks requiresOpenaiAuth');
  if (!Object.hasOwn(auth, 'account')) throw new ProtocolError('account/read lacks account state');
  const account = auth.account === null ? null : record(auth.account, 'account');
  const accountType = account ? safeString(account.type, 'account.type') : null;
  const mode = accountType === null ? 'none' : accountType === 'chatgpt' || accountType === 'apiKey' ? accountType : 'other';
  const models: DiscoveryReport['models'] = [];
  const identities = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page === 20) throw new ProtocolError('Model discovery exceeded the pagination limit');
    const response = record(await peer.request('model/list', { limit: 50, includeHidden: false, ...(cursor ? { cursor } : {}) }), 'model/list');
    if (!Array.isArray(response.data) || response.data.length > 1000) throw new ProtocolError('Invalid model/list data');
    for (const raw of response.data) {
      const model = record(raw, 'model/list entry');
      if (model.hidden === true) continue;
      const id = safeString(model.model, 'model ID');
      if (identities.has(id)) throw new ProtocolError('Model discovery returned a duplicate model ID');
      identities.add(id);
      const displayName = safeString(model.displayName, 'display name');
      if (!Array.isArray(model.supportedReasoningEfforts)) throw new ProtocolError('Model is missing supported reasoning settings');
      const reasoningEfforts = model.supportedReasoningEfforts.map(rawEffort => safeString(record(rawEffort, 'reasoning effort').reasoningEffort, 'reasoning effort'));
      if (new Set(reasoningEfforts).size !== reasoningEfforts.length) throw new ProtocolError('Model has duplicate reasoning settings');
      models.push({ id, displayName, reasoningEfforts });
      if (models.length > 1000) throw new ProtocolError('Model discovery exceeded the catalog size limit');
    }
    if (response.nextCursor === null) break;
    cursor = safeString(response.nextCursor, 'pagination cursor');
    if (cursors.has(cursor)) throw new ProtocolError('Model discovery returned a repeated pagination cursor');
    cursors.add(cursor);
  }
  return {
    mode: 'codex-discovery', observedAt: new Date().toISOString(), codexVersion,
    account: { mode, requiresOpenaiAuth: auth.requiresOpenaiAuth }, models,
    warnings: [
      'A listed model is a runtime catalog entry, not proof a model turn will be authorized or succeed.',
      'Role capabilities remain configuration policy, not measured model quality.',
      ...(mode === 'none' && auth.requiresOpenaiAuth ? ['No signed-in account was reported; the catalog may contain runtime defaults.'] : []),
    ],
    modelTurnsStarted: 0,
  };
}

export async function discoverModels(executable = 'codex'): Promise<DiscoveryReport> {
  const diagnostic = await diagnose(executable);
  if (!diagnostic.ready) throw new ProtocolError('Codex prerequisites are not met. Run orqestra doctor --codex <executable> for details.');
  const { command, prefix } = executableCommand(executable);
  const client = new StdioClient(command, [...prefix, 'app-server']);
  try { return await readDiscovery(client, diagnostic.codex.version!); }
  finally { await client.close(); }
}

/** Intersect observed settings with configured roles; never invent capability evidence. */
export function catalogFromDiscovery(report: DiscoveryReport, config: Config): Catalog {
  const models: Catalog['models'] = [];
  for (const declaration of Object.values(config.models)) {
    if (declaration.runtime !== 'codex') continue;
    const observed = report.models.find(model => model.id === declaration.id);
    if (!observed) continue;
    const reasoningEfforts = observed.reasoningEfforts.filter(effort => declaration.reasoningEfforts.includes(effort));
    if (reasoningEfforts.length) models.push({ id: observed.id, runtime: 'codex', reasoningEfforts, capabilities: declaration.capabilities });
  }
  return parseCatalog({ schemaVersion: 1, observedAt: report.observedAt, capabilitiesSource: 'configuration', models });
}
