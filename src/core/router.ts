import { ROLE_CAPABILITY, type Assignment, type Catalog, type Config, type Role, type RoutePlan, type TaskAssessment } from './types.js';
import { InputError } from './validation.js';

export function selectModel(config: Config, role: Role, catalog?: Catalog): Assignment {
  const rejected: string[] = [];
  for (const candidate of config.roles[role]) {
    const declaration = config.models[candidate.model];
    if (!declaration) throw new InputError(`Unknown model ${candidate.model}; validate configuration first`);
    if (declaration.group === 'premium' && config.limits.maxPremiumWorkers === 0) {
      rejected.push(`${candidate.model}: premium workers disabled`);
      continue;
    }
    if (catalog) {
      const available = catalog.models.find(model => model.id === declaration.id && model.runtime === declaration.runtime);
      if (!available || !available.reasoningEfforts.includes(candidate.reasoning) || !available.capabilities.includes(ROLE_CAPABILITY[role])) {
        rejected.push(`${candidate.model}: absent or incompatible in recorded catalog`);
        continue;
      }
    }
    return {
      role, alias: candidate.model, id: declaration.id, runtime: declaration.runtime,
      reasoning: candidate.reasoning, group: declaration.group,
      reason: rejected.length ? `Configured fallback selected; ${rejected.join('; ')}` : 'First eligible candidate in the configured role policy',
    };
  }
  throw new InputError(`No eligible model for ${role}. ${rejected.join('; ')}. Update this role's candidates or limits; no automatic model or billing substitution was made.`);
}

/** Consumes an explicit assessment; does not inspect a repo or classify prose. */
export function planTask(config: Config, task: TaskAssessment, catalog?: Catalog): RoutePlan {
  const reasons: string[] = [];
  const warnings = [
    'Preview only: no workers started, limits are proposed, and usage is not measured.',
    catalog ? 'Availability is based on a recorded catalog; recheck before execution.' : 'Model availability and capabilities are declared in configuration and remain unverified.',
    'The main Codex conversation model is unchanged by worker policy.',
  ];
  if (catalog?.capabilitiesSource === 'configuration') warnings.push('Catalog identities and reasoning were discovered; role capabilities come from configuration, not runtime evaluation.');
  const verification: RoutePlan['verification'] = task.risk === 'high' ? 'critical-review' : task.complexity === 'complex' || task.ambiguity === 'unclear' || task.independentPackages > 1 ? 'targeted-review' : 'focused';
  const base = {
    schemaVersion: 1 as const, mode: 'preview' as const, profile: config.profile, objective: task.objective,
    verification, packageCount: task.independentPackages, maxAttempts: config.limits.maxAttempts,
    availability: catalog ? 'recorded-catalog' as const : 'unverified' as const,
    catalogObservedAt: catalog?.observedAt ?? null, warnings, usage: null,
  };
  if (task.complexity === 'small' && task.risk === 'low' && task.ambiguity === 'clear' && task.independentPackages === 1) {
    return { ...base, route: 'direct', reasons: ['Small, clear, low-risk work stays in the current Codex session.'], assignments: [], parallelWorkers: 0 };
  }
  const implementation = selectModel(config, 'implement', catalog);
  const capacity = Math.min(config.limits.maxWorkers, implementation.group === 'premium' ? config.limits.maxPremiumWorkers : config.limits.maxWorkers);
  const parallelWorkers = Math.min(task.independentPackages, capacity);
  const coordinated = parallelWorkers > 1;
  const needsPlan = coordinated || task.complexity === 'complex' || task.risk === 'high' || task.ambiguity === 'unclear' || task.independentPackages > 1;
  const assignments: Assignment[] = [];
  if (needsPlan) assignments.push(selectModel(config, 'plan', catalog));
  assignments.push(implementation);
  if (verification !== 'focused') assignments.push(selectModel(config, 'review', catalog));
  if (task.risk === 'high') reasons.push('High risk requires planning and critical review regardless of task size.');
  if (task.ambiguity === 'unclear') reasons.push('Unclear requirements need resolution during planning before implementation.');
  if (task.complexity === 'complex') reasons.push('Complex work benefits from an explicit plan and targeted review.');
  if (coordinated) reasons.push(`${task.independentPackages} independently completable packages permit up to ${parallelWorkers} implementation workers at once.`);
  else reasons.push('One implementation worker avoids unnecessary delegation overhead.');
  if (task.independentPackages > parallelWorkers) reasons.push('Packages beyond available capacity must run sequentially or in later batches.');
  if (needsPlan) warnings.push('Planning, implementation, and review are sequential stages; resolve unclear requirements before dispatch.');
  return { ...base, route: coordinated ? 'coordinated' : needsPlan ? 'planned' : 'single', reasons, assignments, parallelWorkers };
}
