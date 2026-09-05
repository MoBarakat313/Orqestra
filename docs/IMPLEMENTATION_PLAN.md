# Implementation plan

Started: 2026-09-05. Product owner: Mohamed Barakat.

## Decisions

- First experience: inside Codex, through an Orqestra skill and local helper.
- First optimization target: more verified coding work for the available Codex usage. API accounting is a distinct future mode. This prioritization follows the original problem statement; no subscription-to-dollar conversion will be inferred.
- Default policy: Balanced; offer Economy and Quality presets and editable role bindings.
- TypeScript, Node.js 22, a small package, and no runtime framework initially.
- JSON configuration with a versioned, strictly validated schema. A guided interface can write it later; users will not need YAML knowledge.
- Use native Codex capabilities where sufficient. Add helper-controlled dispatch for policies that need deterministic enforcement.
- Explicit model IDs and supported settings in presets; validate actual availability before execution. New model discovery never silently changes a pinned policy.
- Original code under MIT. Reference repositories remain excluded from Git and packages.

## Milestones and acceptance gates

| Milestone | Scope | Acceptance gate | Status |
| --- | --- | --- | --- |
| M0 — Repository and plan | README, contribution guidance, license, design records, Git remote | Initial reviewable commit on the provided repository | In progress |
| M1 — Offline policy foundation | Typed configuration, presets, model selection, explicit task assessment, route preview, demo, CLI tests, CI | Works without credentials; invalid/unsupported configuration fails clearly; reports no invented usage | In progress |
| M2 — Codex compatibility and skill | Diagnostic checks, model discovery over a tested adapter, account-mode awareness, planning skill, project-local installation | Installed runtime is checked before protocol calls; discovery creates no model turn; existing settings preserved; skill works from another project | Planned (diagnostic/skill groundwork may land in M1) |
| M3 — One verified worker | Context contract, one bounded execution, approval forwarding, cancellation, evidence collection, structured report | Real task succeeds on a disposable fixture repo; failed verification cannot produce success; no permission or billing escalation | Planned |
| M4 — Durable execution and repair | Persistent run state, typed failures, bounded attempts, checkpoint-aware resume, cancellation cleanup | Restart/cancel/failure fixtures do not duplicate side effects; escalation preserves relevant evidence and useful edits | Planned |
| M5 — Independent parallel work | Worktree isolation, dependency scheduling, premium/concurrency dispatch limits, integration owner | Conflicting edits do not race; limits hold across failure and cancellation; integrated result is verified | Planned |
| M6 — Accounting and evaluation | Token categories, coordinator visibility/gaps, distinct API/account reports, reproducible direct-vs-Orqestra benchmark | Same initial repo/task conditions; quality and retries reported; no unexecuted counterfactual presented as savings | Planned |
| M7 — Public alpha distribution | Guided setup, versioned packages, diagnostics, reversible installation, configuration migration, compatibility matrix | Clean-machine install and removal verified on supported platforms; all documented commands work; releases contain no private data | Planned |

Each milestone should produce a focused commit or PR with its acceptance evidence. A milestone is complete only when its gate has passed, not merely when scaffolding exists.

## M1 implementation details

1. Define model declarations, role candidates, profiles, limits, explicit task assessments, and route decisions.
2. Validate JSON strictly: reject unknown fields, invalid numeric limits, unknown role/model references, unsupported configured reasoning, duplicate runtime identities, and incompatible capabilities.
3. Keep task assessment explicit for now. A task file contains an objective, complexity, risk, ambiguity, and independently completable package count. Do not sell a keyword classifier as reliable repository analysis.
4. Build a pure router: small clear low-risk tasks stay direct; standard work uses one worker; complex, ambiguous, or high-risk work adds planning; coordination requires independent packages and available capacity. Risk determines verification separately from execution shape.
5. Select from explicitly configured role candidates. An optional recorded catalog filters unsupported runtime/model/settings; declaration-only previews must say availability is unverified. Future models should work without router edits.
6. Add `init`, `validate`, `plan`, `demo`, and `doctor` helper commands. `init` must refuse to overwrite an existing file. None of these commands starts a model turn.
7. Test policy boundaries and CLI behavior including malformed input, unsupported schemas, unavailable models, premium constraints, no-overwrite initialization, and JSON output/error exit codes.
8. Add CI on Linux, macOS, and Windows with Node.js 22. Local macOS validation does not establish the other platforms passed.

## Runtime boundaries

- `src/core/`: pure configuration, role selection, routing, and later state transitions.
- `src/presets.ts`: editable default model choices; no model-specific branching in the router.
- `src/cli.ts`: argument handling and user-readable/JSON output.
- `src/runtime/`: diagnostics first; protocol adapter and dispatch later.
- `skills/orqestra/`: concise Codex instructions reflecting actual installed helper capabilities.
- `tests/`: offline policy and process fixtures, then protocol transcript/recovery fixtures.

Do not duplicate Codex's entire agent loop. Confirm which operations can be controlled and observed through the adapter before promising hard limits. The main conversation model is independent of worker policy; direct work stays with that model.

## Compatibility findings and implementation risks

On the development machine, `codex --version` reported `0.20.0`; `codex app-server --help` returned generic CLI help without an App Server command. A zero exit status alone is not enough to establish support. `doctor` must detect this condition and explain it without modifying the installed CLI.

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server) describes initialization and `model/list`; its evolving surface requires adapter fixtures and an explicit tested-version record. Hosted model documentation does not establish account-specific availability.

Usage events may be delayed; dispatch and retry limits can be hard controls, exact token/dollar limits require honest headroom and best-effort semantics. Worktree ownership is not a security sandbox. Permission boundaries remain enforced by the execution runtime.

## Deferred scope

Automatic policy learning, other providers, local inference runtimes, a desktop dashboard, and automatic global updates. Keep interfaces extensible, but only implement adapters when their end-to-end behavior can be verified.

## Verification record

- Reference research: 47 upstream lifecycle tests passed; these are not Orqestra tests or savings evidence.
- Orqestra checks: pending M1 implementation.
