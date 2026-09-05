# Durable worker execution

M4 runs a bounded implementation and repair loop for a clean Git repository. The task must route to `single`, the selected runtime must be `codex`, and every declared verification command must pass before Orqestra reports success.

```sh
orqestra run \
  --request execution.json \
  --project /absolute/path/to/project \
  --config orqestra.config.json
```

Use `--codex /path/to/codex` to select a compatible executable and `--turn-timeout 600` to shorten the default 900-second turn limit. `SIGINT` and `SIGTERM` request `turn/interrupt` during a worker turn and terminate active verification. On Unix, verification commands run in their own process group so cancellation also targets descendants.

## Execution contract

The request is strict JSON. See [the example](../examples/execution.json).

- `task` uses the same explicit assessment as `plan`. `run` accepts only a standard `single` route. Direct work stays in the current Codex conversation; multi-package work uses the separate M5 [`coordinate`](COORDINATION.md) contract.
- `acceptanceCriteria` contains 1–20 concrete outcomes supplied to the worker.
- `verification` contains 1–10 commands. Each command is an argument array, never a shell string, and has a 1–600 second timeout. Commands run sequentially from the project directory and stop after the first failure.

The project must be a clean Git repository with a commit. Use a disposable repository or disposable Git worktree: normal Git status does not cover ignored files, so Orqestra cannot prove an ignored cache, build artifact, credential file, or external side effect was untouched. The worker receives project-scoped write access, disabled network access, the selected model/reasoning setting, loaded project instructions, and a prompt that prohibits Git-history changes, ignored/credential-file edits, and subagents. The runtime catalog is checked before each turn.

## Checkpoints and retries

The default checkpoint is `.git/orqestra/runs/<run-id>.json`, using the worktree's actual private Git directory. `--state-dir <directory>` selects a location outside the project working tree; an in-tree location is rejected because it would contaminate change evidence. State updates use a same-directory temporary file, file synchronization, and atomic rename. A per-run lock prevents concurrent runners; a dead process's well-formed lock is cleared on resume.

The checkpoint records the run ID, revision, phase, selected model, attempt limit, thread/turn IDs, Git `HEAD`, changed paths, evidence hashes, verification result hashes, and typed failure codes. It does not persist the execution contract, verification commands, verifier output, agent messages, approval details, credentials, or backend logs. Resume therefore requires the same request and policy; their hashes must match the checkpoint.

Failed verification keeps the selected model and starts a repair turn in the persisted Codex thread until `maxAttempts` is reached. The repair prompt receives bounded failure output in memory, while the checkpoint receives only its hash and byte count. Worker failure can also consume another bounded attempt. Cancellation and approval-required outcomes are terminal and never retry automatically.

## Resume after interruption

An unexpected App Server or transport exit produces `status: "paused"`. Resume it with the same inputs:

```sh
orqestra resume \
  --run-id <run-id> \
  --request execution.json \
  --project /absolute/path/to/project \
  --config orqestra.config.json
```

If Git-visible edits appeared after the last worker checkpoint, resume verifies them before starting another worker. Passing checks finish the run without another model turn. Failed checks consume the interrupted attempt and may start one repair turn if budget remains. If no edits appeared, the interrupted attempt is recorded and repair may continue. A changed Git `HEAD` or an unexpected change between stable checkpoints produces `state-conflict` and preserves the project for review. Resuming a terminal run is idempotent.

The persisted thread is non-ephemeral. Repair calls `thread/resume` and then starts a new turn, consistent with the [official Codex App Server lifecycle](https://learn.chatgpt.com/docs/app-server). Orqestra never tries to replay a previously acknowledged turn.

## Success and evidence

`status: "succeeded"` requires all of the following:

1. Codex finishes a turn with `completed`, or recovered edits independently pass verification.
2. Git `HEAD` is unchanged and at least one working-tree file changed.
3. Every independent verification command exits successfully.

The live report can include bounded verifier output and the worker's final message. The durable checkpoint contains only bounded metadata and hashes. `verification-failed`, `worker-failed`, `cancelled`, `approval-required`, and `state-conflict` are terminal non-success states. Changes remain in the project; Orqestra does not reset, stash, commit, or delete them.

## Approvals and usage

The worker uses Codex `on-request` approvals. The transport accepts only command and file-change approval requests matching the active thread and turn. The CLI has no approval handler, so it replies `cancel`, interrupts the turn, reports `approval-required`, and never grants extra access automatically.

Authentication refresh, tool input, MCP elicitation, and other server requests remain unsupported and fail closed.

The live worker report records final App Server token categories. Durable state persists the bounded usage summary for each completed attempt, allowing repair totals to survive resume. Fresh threads use their cumulative total; resumed threads use a before-and-after cumulative delta. Missing pre-turn or final snapshots remain explicit gaps. ChatGPT account usage is not converted to API cost, API billed amounts are unavailable without separate evidence, and the main Codex conversation remains outside the helper's visibility. See [usage accounting and paired evaluation](ACCOUNTING_AND_EVALUATION.md).
