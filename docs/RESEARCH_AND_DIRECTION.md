# Orqestra: research and proposed direction

Status: discussion draft, not an implemented product or an approved specification.
Reviewed: 2026-09-05.

## Product intent

Build a downloadable, configurable coding orchestrator that helps people complete work with less wasted model usage. Support the GPT-5.6 family, GPT-6 Astra, and future models through configuration and replaceable integrations. Make setup understandable to everyday users. The user selected **inside Codex, with simple setup and commands** as the first delivery surface.

Optimize for the cost and time of a successfully verified task, including exploration, planning, failures, repairs, and review. Token count alone is not the objective.

## What was inspected

- Full [shared ChatGPT conversation](https://chatgpt.com/share/6a9c44e1-d2a4-83eb-99bf-1d319ee60c15), including the comparison and Orqestra proposal.
- Full ordinary Git clone of [codex_workflow](https://github.com/viettran-edgeAI/codex_workflow), including history: commit `e6c899ffd82d7d32aa9f93f0986a402add47c32d`, release preparation for v1.1.3. Local reference: `.references/codex_workflow/`.
- Main workflow instructions, Heavy route, model definitions, configuration validation, CLI lifecycle, release acquisition, transaction handling, benchmark README, and regression tests.
- README-level inspection of [Codex-Subagent-Orchestrator](https://github.com/lemos999/Codex-Subagent-Orchestrator), [Glaicer's orchestrator](https://github.com/Glaicer/subagent-orchestrator-skill), and [claude-codex-fleet](https://github.com/Inphinity-Design/claude-codex-fleet). These were not independently tested or fully audited.
- Official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server), [GPT-6 Astra guidance](https://developers.openai.com/api/docs/guides/latest-model), and [GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol).

The downloaded workflow was not installed into the user's Codex configuration. Its instructions are reference material, not Orqestra's active instructions. The reference clone is excluded from version control. No license file or license grant was found in the inspected checkout; build original implementation and documentation rather than importing its files for redistribution without resolving reuse terms.

## Findings from source

| Finding | Evidence at the inspected commit | Implication |
| --- | --- | --- |
| Lifecycle implementation has useful separation of responsibilities | `docs/runtime_architecture.md`, `runtime/transaction.py`, `runtime/release.py` | Learn from configuration ownership, migrations, checksum verification, and rollback concepts. |
| Routing is user-selected, with Light as default | `codex_workflow/AGENTS.md` | Automatic complexity routing would be new Orqestra behavior. |
| Medium keeps implementation with the main agent, with Explorer and closure-worker exceptions | `codex_workflow/AGENTS.md` | The chat's suggestion that Medium automatically offloads coding to a cheaper model is not the upstream contract. |
| Default executor choices are explicitly Luna or Terra | `runtime/config.py`: `DEFAULT_EXECUTORS` | Model-independent configuration needs a different schema. |
| Sol is separately encoded in configuration and worker identity | `max_executor_sol_instances`, `agents/executor_sol.toml` | Use configurable model groups and role bindings instead of special Sol fields. |
| Worker counts are validated and rendered into instructions | `runtime/config.py`, `heavy_route.md` | There is no independent worker scheduler here enforcing the complete orchestration policy. Some platform controls exist, but role-specific behavior relies on agent compliance. |
| Heavy defines bounded context and compact reports | `heavy_route.md` | Preserve explicit ownership, acceptance criteria, evidence references, and targeted repair. |
| Repair escalation already exists | `heavy_route.md`: same criterion failing after two focused repair attempts escalates to the main agent | Orqestra should add configurable model selection after escalation, rather than claim the original lacks escalation. |
| Upstream defaults permit 20 concurrent workers and one Sol executor | `resources/workflow_config.default.json` | Start smaller; the appropriate number depends on independent work and account capacity. |
| The benchmark README links a prompt and presents screenshots | `light_benchmark/README.md` | This inspection does not establish repeatable cross-model savings. |

Validation: `python3 -B -m unittest discover -s scripts -p 'test_workflow_runtime.py'` passed all **47 tests**. These validate lifecycle/configuration behavior; they do not establish agent quality, savings, or live model compatibility.

## Corrections to the earlier brainstorming

1. Numerical model intelligence ratings and orchestrator rankings in the chat are illustrative opinions, not calibrated measurements. Start with explicit presets and collect task-level evidence.
2. A cheaper token price can still produce a more expensive completed task after retries. A more capable model can be the economical first choice for difficult work.
3. ChatGPT/Codex allowance and API dollars require separate reporting. Do not derive subscription consumption from API prices. Account-wide usage changes can include concurrent work elsewhere.
4. Do not label an unexecuted comparison as tokens saved. Compare against recorded baselines and label estimates, unknowns, and measurements separately.
5. New models require capability validation and evaluation, not only a new string in a config file. Existing API-compatible models should be addable through configuration; new protocols/features can require adapter work.
6. The term `5.6F` is unresolved. The conversation discusses Sol, Terra, and Luna; do not invent an API model ID from the shorthand.

## Proposed architecture

The orchestration engine owns task state, scheduling, limits, evidence, and recovery. Model calls provide planning and execution inside those boundaries.

```text
User interface: Codex integration / CLI / eventual desktop interface
                              |
                    Orqestra orchestration engine
                              |
         Router -- Model policy -- Context preparation
                              |
           Scheduler -- Verification -- Targeted escalation
                              |
              Runtime adapters (Codex first)
                              |
                    Available models and tools

Shared services: run journal, usage accounting, workspace isolation
```

Use separate interfaces for model discovery/inference and execution runtimes. A local model API is not automatically a coding agent with shell tools, sandboxing, approvals, and resumable sessions.

Suggested implementation language: TypeScript for the local helper and orchestration engine. Keep a small package structure until there is an actual need for a monorepo. The user-facing entry point is a Codex skill; any helper CLI is primarily an integration surface.

### Model policy

- Roles: explore, implement, plan, review, escalate. Roles do not contain model names.
- Profiles: Economy, Balanced, Quality, Custom. Each binds roles to user-approved models and supported reasoning settings.
- A catalog records model IDs, provider/runtime, supported settings, capability evidence, and dated pricing metadata when available.
- Discover availability at startup; keep explicit policy pins. Newly discovered models become candidates rather than silently replacing a tested default.
- Codex App Server documents `model/list`, supported reasoning settings, managed ChatGPT sign-in, and account rate-limit reads. Validate the installed version's actual schema before implementation.
- Gate Astra-specific features separately. Its API documentation describes async tools and mid-turn steering; that does not establish identical support through every runtime adapter.
- An unavailable model produces a clear explanation and follows a configured fallback. Never silently change billing mode or use API billing as a subscription fallback.

### Routing and execution

- Three execution shapes: direct, planned single worker, coordinated workers. Risk is a separate dimension; a short task can be high risk.
- Start with transparent rules and user overrides. Use a small classification call only where it can change the execution decision.
- Bounded context includes task, source revision, files/symbols, relevant project rules, constraints, acceptance criteria, and exact evidence references. Workers may request missing context.
- Start with one writer. Add concurrency only after isolation and integration checks work; propose two concurrent workers and one premium-model slot as initial limits.
- For parallel edits, use separate worktrees and an integration owner. A file list in a prompt is not a filesystem access control.
- Execute checks as normal processes when possible. Validate exit codes and artifacts; an agent's success report alone is insufficient.
- Failure types include invalid setup, missing access, flaky verification, implementation defect, and architectural uncertainty. Escalate model reasoning only when it addresses the failure.
- Bound retries and total work. Preserve useful diffs and failure evidence when switching models.
- Persist state transitions and tool actions so restarting cannot blindly duplicate writes or external actions. Suggested states: queued, running, verifying, needs-input, completed, failed, cancelled.
- Enforce worker counts, retries, and deadlines in code. Token budgets based on delayed usage reports are best-effort; reserve headroom and distinguish dispatch limits from exact billing caps.

### Codex integration choice

Codex is the proposed first execution runtime because it matches the original goal of managing Codex usage. Prefer a local stdio integration for the first compatibility spike. The current App Server documentation marks its command/WebSocket surface experimental; pin tested versions and keep protocol changes confined to the adapter.

Confirmed first experience: a Codex skill with guided setup and simple commands, backed by a local helper where deterministic enforcement is needed. Prompts alone cannot guarantee model switching, budgets, or scheduler behavior. The implementation spike should verify that the skill can call the helper, launch bounded workers through the runtime adapter, and return compact results without creating two competing orchestration loops.

The existing Codex conversation remains the user interface. Its selected main model is separate from worker model policy; changing a worker assignment does not change the main conversation model. Track coordinator usage separately where the host exposes it and report gaps honestly. Prefer native worker facilities where sufficient, but label role-specific limits as advisory unless code controls dispatch.

### Installation and everyday usability

- Target experience: download a release, follow guided setup in Codex, validate the current sign-in/runtime, select a project and profile, and invoke the Orqestra skill on a task.
- Provide packaged releases with clear prerequisites; downloading source alone is not equivalent to a ready-to-run app.
- Include a no-credentials demo and a diagnostic command that explains missing runtime, sign-in, unavailable models, and incompatible versions.
- Preserve existing project instructions and Codex settings. Use explicit project integration with previews and reversible removal.
- Keep configuration editing optional. Advanced users can set per-role models, reasoning, fallback policy, and concurrency.
- Ship versioned configuration migrations, a compatibility matrix, release integrity checks, and an explicit license for our original project before public release.

## Proposed first milestone

Prove one complete loop: a user selects a repository and profile, Orqestra discovers available models, explains its route, runs one bounded task, verifies it, records usage, and resumes cleanly after interruption.

Include a small representative benchmark against direct Codex execution on identical starting revisions. Report completion quality, regressions, retries, elapsed time, token categories, API cost where applicable, and carefully attributed account-usage observations. Repeat tasks enough to expose variability before publishing savings claims.

Defer automatic policy learning, a large specialist catalog, full multi-provider support, and a complex dashboard until this loop is reliable. Keep extension interfaces in the design from the beginning.

## Decisions for our discussion

1. First experience: **confirmed inside Codex**, with simple setup and commands.
2. First objective: stretch Codex subscription usage, minimize API cost, or both with distinct modes?
3. Default profile: Economy or Balanced? Recommend Balanced initially while collecting evidence.
4. Scope: coding repositories first? Recommend yes.

No application implementation, upstream installation, GitHub publication, or performance claim has been made by this research step.
