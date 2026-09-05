# Independent parallel work

M5 executes an explicit multi-package contract with isolated Git worktrees, dependency-aware dispatch, hard worker limits, durable child runs, and one deterministic integration owner.

```sh
orqestra coordinate \
  --request coordination.json \
  --project /absolute/path/to/project \
  --config orqestra.config.json
```

The source project must be a clean Git repository with a commit. Orqestra records that commit, creates one detached worktree per package, and runs each package through the M4 durable worker. This follows Codex's [documented worktree isolation model](https://developers.openai.com/codex/app/worktrees). Package worktrees and coordination state live under private Git metadata. The original checkout remains at its recorded commit and is checked again before and after integration.

## Coordination contract

See [the example](../examples/coordination.json). The strict JSON contract contains:

- One explicit low-risk, clear task assessment with 2–16 independently completable packages.
- A unique lowercase ID, objective, dependency list, owned paths, acceptance criteria, and verification commands for each package.
- Final verification commands for the combined result.

Owned paths are normalized repository-relative files or directories outside `.git`. Package ownership must not overlap. Orqestra rejects missing dependencies, cycles, duplicate IDs, path traversal, and a package count that differs from `task.independentPackages` before dispatch.

Ownership is an integration invariant rather than a security boundary. The Codex worker still runs with project-scoped workspace permissions and disabled network access. If its Git-visible change set contains any path outside its declared ownership, the package fails and is not committed or integrated. Ignored files and external side effects remain outside Git evidence.

## Scheduling and limits

A package becomes runnable only after every declared dependency has produced a verified commit. Those commits are applied to its isolated worktree before its durable worker starts, so the worker sees the exact predecessor changes it depends on. A failed, cancelled, or blocked dependency blocks downstream packages.

The scheduler never has more than `limits.maxWorkers` active implementation workers. When the selected implementation model belongs to the `premium` group, it also never has more than `limits.maxPremiumWorkers` active workers. The report and checkpoint record maximum observed total and premium concurrency. Limits remain in force while other workers fail, pause, or respond to cancellation.

Each package inherits `limits.maxAttempts` and the M4 checkpoint behavior. Unexpected App Server transport loss pauses that package and the overall run. Continue it with the same project, request, policy, and run ID:

```sh
orqestra coordinate-resume \
  --run-id <run-id> \
  --request coordination.json \
  --project /absolute/path/to/project \
  --config orqestra.config.json
```

Committed packages are not dispatched again. Paused packages resume their saved durable child run. Hash mismatches, limit changes, or a changed original checkout are rejected. A terminal coordination run is idempotent when resumed.

## Integration owner

After all packages commit, Orqestra creates a separate detached integration worktree at the recorded base commit. The integration owner is deterministic Orqestra code: it applies verified package commits in topological order and invokes no extra model. This keeps assembly reproducible and prevents an integration model from silently rewriting package output.

The coordination contract is the completed plan supplied to this command. Any `plan` role and `review` role shown by the preview remain advisory in M5; `coordinate` invokes only the selected implementation model, followed by deterministic assembly and declared verification.

Every final verification command must pass before the run reports `succeeded`. The report returns the integration worktree path, integrated commit, changed paths, and live bounded verification results. It does not merge, cherry-pick, or copy the result into the user's checkout. The verified worktree remains available for review and an explicit later Git action.

An integration conflict or failed final check reports `integration-failed` and preserves the isolated worktree for diagnosis. Package failure reports `package-failed`; cancellation reports `cancelled`; original-checkout drift reports `state-conflict`. None of these states is success.

## Checkpoint data

The aggregate checkpoint is `.git/orqestra/coordinated/<run-id>/state.json`. Atomic updates record package states, child run IDs, dependency applications, commits, worktree paths, concurrency observations, input hashes, final verification hashes, and typed failure codes. Child M4 checkpoints remain in each linked worktree's private Git directory.

Contracts, command arrays, verifier output, agent messages, credentials, approval details, and backend logs are excluded from the aggregate checkpoint. Each package persists its durable usage summary. The final report adds attempt-local token observations across packages and states how many turns were unmeasured. The deterministic integration owner starts zero model turns, while the main Codex conversation remains outside the helper's visibility. No ChatGPT-to-dollar conversion or unobserved savings estimate is made. See [usage accounting and paired evaluation](ACCOUNTING_AND_EVALUATION.md).
