import type { Candidate, Config, Profile, Role } from './core/types.js';

/** Policy defaults, not a measured ranking or proof of account availability. */
export function createPreset(profile: Exclude<Profile, 'custom'> = 'balanced'): Config {
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  const models: Config['models'] = {
    economical: { id: 'gpt-5.6-luna', runtime: 'codex', group: 'standard', reasoningEfforts: [...efforts], capabilities: ['read', 'code', 'plan', 'review'] },
    balanced: { id: 'gpt-5.6-terra', runtime: 'codex', group: 'standard', reasoningEfforts: [...efforts, 'ultra'], capabilities: ['read', 'code', 'plan', 'review'] },
    senior: { id: 'gpt-5.6-sol', runtime: 'codex', group: 'premium', reasoningEfforts: [...efforts, 'ultra'], capabilities: ['read', 'code', 'plan', 'review'] },
    advanced: { id: 'gpt-6-astra', runtime: 'codex', group: 'premium', reasoningEfforts: [...efforts, 'ultra'], capabilities: ['read', 'code', 'plan', 'review'] },
  };
  const candidate = (model: string, reasoning = 'medium'): Candidate => ({ model, reasoning });
  const bindings: Record<Exclude<Profile, 'custom'>, Record<Role, Candidate[]>> = {
    economy: {
      explore: [candidate('economical')], implement: [candidate('economical'), candidate('balanced')],
      plan: [candidate('balanced')], review: [candidate('balanced')], escalate: [candidate('senior', 'high')],
    },
    balanced: {
      explore: [candidate('economical'), candidate('balanced')], implement: [candidate('balanced')],
      plan: [candidate('senior')], review: [candidate('senior')], escalate: [candidate('advanced', 'high'), candidate('senior', 'high')],
    },
    quality: {
      explore: [candidate('balanced')], implement: [candidate('senior', 'high')],
      plan: [candidate('advanced', 'high')], review: [candidate('advanced', 'high')], escalate: [candidate('advanced', 'high')],
    },
  };
  return { schemaVersion: 1, profile, models, roles: bindings[profile], limits: { maxWorkers: 2, maxPremiumWorkers: 1, maxAttempts: 2 } };
}
