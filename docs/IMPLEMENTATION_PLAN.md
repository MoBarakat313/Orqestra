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
| M0 — Repository and plan | README, contribution guidance, license, design records, Git remote | Initial reviewable commit on the provided repository | Complete — initial plan pushed to `main` |
| M1 — Offline policy foundation | Typed configuration, presets, model selection, explicit task assessment, route preview, demo, CLI tests, CI | Works without credentials; invalid/unsupported configuration fails clearly; reports no invented usage | Complete — original 27 tests and packaging passed on all CI platforms |
| M2 — Codex compatibility and skill | Diagnostic checks, model discovery over a tested adapter, account-mode awareness, planning skill, project-local installation | Installed runtime is checked before protocol calls; discovery creates no model turn; existing settings preserved; skill works from another project | Complete — 47 local tests pass; real discovery and skill detection verified on Codex 0.153.4; hosted checks tracked in GitHub Actions |
| M3 — One verified worker | Context contract, one bounded execution, approval forwarding, cancellation, evidence collection, structured report | Real task succeeds on a disposable fixture repo; failed verification cannot produce success; no permission or billing escalation | Complete — 57 local tests pass; real Codex 0.153.4 worker and independent verification succeeded without approvals |
| M4 — Durable execution and repair | Persistent run state, typed failures, bounded attempts, checkpoint-aware resume, cancellation cleanup | Restart/cancel/failure fixtures do not duplicate side effects; escalation preserves relevant evidence and useful edits | Complete — 68 local tests pass; persisted-thread repair, interrupted-edit recovery, stale-lock cleanup, cancellation, process-tree cleanup, and attempt exhaustion are fixture-tested |
| M5 — Independent parallel work | Worktree isolation, dependency scheduling, premium/concurrency dispatch limits, integration owner | Conflicting edits do not race; limits hold across failure and cancellation; integrated result is verified | Complete — 78 local tests pass; isolated scheduling, durable resume, ownership checks, deterministic integration, and final verification are fixture-tested |
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
- M1: TypeScript compilation and 27 offline tests passed on macOS with Node.js 22.22.3, then all three CI platforms.
- `npm pack --dry-run`: distribution allowlist inspected; no `.references`, credentials, local policy files, test fixtures, or dependency tree included.
- Local package archive installed into an isolated temporary prefix with installation scripts disabled; its executable successfully ran all four offline demo scenarios from outside the source checkout.
- Planning skill passed the skill-creator frontmatter/scaffold validator. This is structural validation, not proof of autonomous skill behavior.
- `doctor --json`: correctly reported local `codex-cli 0.20.0` as incompatible with App Server, with no sign-in, update, or model turn.
- M1 hosted CI: [run 33981037799](https://github.com/MoBarakat313/Orqestra/actions/runs/33981037799) passed on Linux, macOS, and Windows.
- M2: added bounded JSONL transport, model/account-mode discovery, catalog provenance, a portable helper entrypoint, and project-local skill install/remove with integrity checks. See [COMPATIBILITY.md](COMPATIBILITY.md) for real runtime evidence and explicit limits.
- M2 real model discovery and skill listing started zero model turns. All 47 local tests pass; fixture tests cover preservation, rollback, protocol failures, and timeouts. The packaged installer and installed helper worked from an independent temporary project. Hosted checks are available in [GitHub Actions](https://github.com/MoBarakat313/Orqestra/actions).
- M3: added a strict execution contract, live model/effort validation, one ephemeral worker turn, project-only writes with network disabled, scoped approval handling, signal/timeout interruption, Git change evidence, and independent bounded verification. A real Terra/medium turn on Codex 0.153.4 created one file in a disposable clean repository; both fixture tests passed, Git `HEAD` stayed unchanged, no approval was requested, and the content-aware evidence digest was recorded. Offline fixtures prove failed verification cannot report success and approval requests default to cancellation.
- M4: added atomic run checkpoints under private Git metadata, typed terminal and pause failures, policy-bounded repair attempts, persisted Codex threads, checkpoint-aware recovery, single-run locks with dead-owner cleanup, and process-group termination for verification on Unix. The durable state stores input hashes and bounded evidence metadata rather than contracts, commands, output, agent messages, credentials, or backend logs. Fixtures prove repair uses `thread/resume`, interrupted edits are verified before another worker starts, cancellation does not retry, terminal resume is idempotent, stale locks are recoverable, and exhausted verification retains edits without success. A live Codex 0.153.4 run paused cleanly after sandbox-blocked discovery, resumed with the same run ID under permitted runtime access, created one requested file, passed both tests, and kept Git `HEAD` unchanged.
- M5: added strict package contracts with explicit path ownership and an acyclic dependency graph, detached worktree creation from one recorded base commit, dependency-gated scheduling, durable child runs, hard total and premium worker caps, verified package commits, and deterministic topological integration in a separate worktree. Aggregate state uses atomic checkpoints and a stale-safe run lock while excluding contracts, commands, output, messages, credentials, and backend logs. Fixtures prove independent workers overlap only within capacity, premium work stays within its configured slot, dependents wait for committed predecessors, failures block downstream work, cancellation starts no excess workers, paused children resume without repeating completed siblings, exact commit patch recovery works across dependency history, and failed final verification cannot report success.

## Next work package

M6: add honest usage categories and visibility gaps, distinct account/API reports, and a reproducible direct-versus-Orqestra evaluation harness. Do not claim savings from unexecuted counterfactuals.
