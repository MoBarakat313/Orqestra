export const ROLES = ['explore', 'implement', 'plan', 'review', 'escalate'] as const;
export type Role = (typeof ROLES)[number];
export type Profile = 'economy' | 'balanced' | 'quality' | 'custom';
export type Capability = 'read' | 'code' | 'plan' | 'review';

export interface ModelDeclaration {
  id: string;
  runtime: string;
  group: 'standard' | 'premium';
  reasoningEfforts: string[];
  capabilities: Capability[];
}

export interface Candidate {
  model: string;
  reasoning: string;
}

export interface Config {
  schemaVersion: 1;
  profile: Profile;
  models: Record<string, ModelDeclaration>;
  roles: Record<Role, Candidate[]>;
  limits: {
    maxWorkers: number;
    maxPremiumWorkers: number;
    maxAttempts: number;
  };
}

export interface TaskAssessment {
  objective: string;
  complexity: 'small' | 'standard' | 'complex';
  risk: 'low' | 'high';
  ambiguity: 'clear' | 'unclear';
  independentPackages: number;
}

/** A recorded observation, never an inference from preset names. */
export interface Catalog {
  schemaVersion: 1;
  observedAt: string;
  capabilitiesSource?: 'configuration';
  models: Array<{
    id: string;
    runtime: string;
    reasoningEfforts: string[];
    capabilities: Capability[];
  }>;
}

export const ROLE_CAPABILITY: Record<Role, Capability> = {
  explore: 'read', implement: 'code', plan: 'plan', review: 'review', escalate: 'code',
};

export interface Assignment {
  role: Role;
  alias: string;
  id: string;
  runtime: string;
  reasoning: string;
  group: ModelDeclaration['group'];
  reason: string;
}

export interface RoutePlan {
  schemaVersion: 1;
  mode: 'preview';
  profile: Profile;
  objective: string;
  route: 'direct' | 'single' | 'planned' | 'coordinated';
  reasons: string[];
  verification: 'focused' | 'targeted-review' | 'critical-review';
  assignments: Assignment[];
  parallelWorkers: number;
  packageCount: number;
  maxAttempts: number;
  availability: 'unverified' | 'recorded-catalog';
  catalogObservedAt: string | null;
  warnings: string[];
  usage: null;
}
