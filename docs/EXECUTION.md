# One-worker execution

M3 adds one bounded implementation turn for a clean Git repository. It is intentionally narrow: the task must route to `single`, the selected runtime must be `codex`, and every declared verification command must pass before Orqestra reports success.

```sh
orqestra run \
  --request execution.json \
  --project /absolute/path/to/project \
  --config orqestra.config.json
```

Use `--codex /path/to/codex` to select a compatible executable and `--turn-timeout 600` to shorten the default 900-second worker limit. `SIGINT` and `SIGTERM` request `turn/interrupt` during the worker turn and terminate the active verification command afterward.

M3 bounds the directly spawned verification process. Cleanup of descendant processes created by a verification script is part of M4, so verification commands should run in the foreground and manage their own children.

## Execution contract

The request is strict JSON. See [the example](../examples/execution.json).

- `task` uses the same explicit assessment as `plan`. M3 accepts only a standard `single` route. Direct work stays in the current Codex conversation; planned and coordinated routes arrive in later milestones.
- `acceptanceCriteria` contains 1–20 concrete outcomes supplied to the worker.
- `verification` contains 1–10 commands. Each command is an argument array, never a shell string, and has a 1–600 second timeout. Commands run sequentially from the project directory and stop after the first failure.

The project must be a clean Git repository with a commit. M3 is intended for a disposable repository or disposable Git worktree: normal Git status does not cover ignored files, so this milestone cannot prove an ignored cache, build artifact, or credential file was untouched. The worker receives project-scoped write access, disabled network access, the selected model/reasoning setting, loaded project instructions, and a prompt that prohibits Git-history changes, ignored/credential-file edits, and subagents. The runtime catalog is checked immediately before the turn.

## Success and evidence

`status: "succeeded"` requires all of the following:

1. Codex finishes the turn with `completed`.
2. Git `HEAD` is unchanged and at least one working-tree file changed.
3. Every independent verification command exits successfully.

The report includes changed paths, a SHA-256 digest and byte count over Git status, the tracked diff, and untracked file contents, plus verification exit status and bounded output, the worker's final message, timestamps, thread/turn IDs, and a redacted runtime-error category when available. Backend error text is omitted because it may contain private account details. M3 attempts exactly one worker and reports `usage: null`; it does not yet claim token savings.

Failed verification returns `verification-failed` and a nonzero CLI exit. Worker failure, unauthorized Git-history changes, and a turn that produces no files return `worker-failed`. Changes remain in the project for review; Orqestra does not reset or delete them.

## Approvals and cancellation

The worker uses Codex `on-request` approvals. The transport accepts only command and file-change approval requests that match the active thread and turn. The reusable worker API forwards a bounded request to an explicit approval handler. The CLI installs no approval handler, so its fail-closed default replies `cancel`, interrupts the turn, returns `approval-required`, and never grants extra access automatically.

This first boundary makes automated approval impossible. A later Codex UI adapter can present the forwarded request to the user and return their decision without changing the worker protocol. Authentication refresh, tool input, MCP elicitation, and other server requests remain unsupported and fail closed.

Protocol behavior follows the [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server): clients stream `turn/*` and `item/*` events, answer server-initiated approval requests, and cancel active work with `turn/interrupt`.
