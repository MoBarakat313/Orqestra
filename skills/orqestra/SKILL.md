---
name: orqestra
description: Preview a coding task's route and model assignments, discover Codex models, diagnose prerequisites, or run and resume a durable bounded implementation worker using an Orqestra policy.
---

# Orqestra policy previews

Use `node <this-skill-directory>/scripts/orqestra.mjs` as the helper command (called `orqestra` below). The project installation bundles its runtime, so no global npm package is required. A source checkout must first be built. Node.js 22 or newer is required.

- `orqestra --help` lists the supported commands. `orqestra demo --json` demonstrates routing without credentials or project edits.
- For setup, create a policy with `orqestra init --profile balanced --config <path>`. Economy and Quality are alternatives. The helper refuses to overwrite existing files. Keep existing project instructions and Codex settings intact.
- For a task preview, inspect only enough relevant repository context to assess scope, risk, ambiguity, and independence. Write a JSON assessment containing `objective`, `complexity` (`small`, `standard`, `complex`), `risk` (`low`, `high`), `ambiguity` (`clear`, `unclear`), and `independentPackages` (1 unless packages are independently completable).
- Call `orqestra plan --task <assessment.json> --config <policy.json> --json`. Keep temporary assessment files in a local ignored directory or temporary workspace. The assessment is your judgment; the helper does not inspect the repository or classify natural language.
- Explain the route, proposed models, verification depth, and material assumptions. Small high-risk changes still need critical review. Resolve ambiguity before any later implementation.
- For execution, proceed only when the task is standard, clear, low risk, independently completable by one worker, and the target is a disposable clean Git repository or worktree. Git evidence cannot prove ignored files were untouched. Create a strict execution JSON with the assessment, 1–20 concrete acceptance criteria, and 1–10 verification entries shaped as `{ "name": "...", "command": ["executable", "arg"], "timeoutSeconds": 300 }`. Never use a shell string or put credentials in command arguments.
- Run `orqestra run --request <execution.json> --project <absolute-project-path> --config <policy.json> --json`. The policy's `maxAttempts` bounds verification repair turns. Success requires a working-tree change, unchanged Git history, and every independently executed check to pass. A non-success report is not a successful implementation.
- If the report is `paused`, use its run ID with `orqestra resume --run-id <id> --request <same-execution.json> --project <same-project> --config <same-policy.json> --json`. Do not start a fresh run over its edits. Resume rejects changed inputs, verifies edits from an interrupted turn before repair, and reopens the saved Codex thread. Terminal resume is safe and starts no new turn.
- The CLI cancels and reports any approval request instead of granting it. Show the user the returned bounded approval details. Do not retry with broader permissions or altered policy without explicit user authorization. `SIGINT`/`SIGTERM` requests worker interruption.
- `orqestra doctor --json` checks the CLI prerequisite without signing in, updating software, or starting a model turn. A detected App Server command does not prove protocol compatibility or account availability.
- `orqestra models --json` initializes a local Codex App Server and reads account mode and model settings. It does not log in or start turns. Use `--codex <executable>` to select a compatible CLI; JavaScript entrypoints are supported. Export a policy-filtered catalog with `models --config <policy.json> --output <catalog.json>`. Existing files are not overwritten. Do not treat listed models as guaranteed authorization, or configured role capabilities as measured quality.

Task plans remain previews until `run` is invoked. Do not claim parallel execution or measured savings. Durable recovery covers Git-visible project edits; it does not prove ignored files or external side effects were untouched. The selected main Codex model remains unchanged. Discovery is read-only at the protocol level; the Codex process may maintain its own normal caches/logs.
