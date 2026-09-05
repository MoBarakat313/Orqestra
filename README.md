# Orqestra

Configurable orchestration for coding work inside Codex.

Orqestra chooses suitable models, keeps worker context focused, and makes execution and usage easier to understand. Its first interface is a Codex skill with guided setup, backed by a local helper.

**Status: public alpha (`0.1.0-alpha.1`).** Configuration, model policies, route previews, read-only Codex model discovery, project-local setup and upgrades, durable bounded worker execution, isolated multi-package coordination, measured worker token reports, and paired evaluation are implemented. Published savings claims are not available.

## Direction

- Economy, Balanced, Quality, and custom model policies.
- Role definitions independent of model names, including GPT-5.6 and GPT-6 Astra presets.
- Direct work for small tasks; delegation when it has a concrete benefit.
- Bounded retries, targeted verification, resumable work, and honest usage reporting.
- Compatibility checks before live execution, with no silent switch from subscription usage to API billing.

The [research and design discussion](docs/RESEARCH_AND_DIRECTION.md) explains the rationale and what was inspected. The project contains original implementation; third-party reference checkouts are not distributed.

## Install the public alpha

Requires Node.js 22 or newer and npm. Download the archive and checksum from the [latest release](https://github.com/MoBarakat313/Orqestra/releases/latest), verify the SHA-256 value, then install the archive and set up a project:

```sh
npm install --global ./mobarakat313-orqestra-0.1.0-alpha.1.tgz
orqestra setup --project /absolute/path/to/your-project --profile balanced
```

Open or reload that project in Codex and ask **`$orqestra preview a plan for my task`**. Setup creates the policy and a self-contained project skill while preserving existing skills, instructions, and Codex settings.

No API key or Codex account is needed for the offline demo:

```sh
orqestra demo
orqestra doctor
```

The task file contains an **explicit assessment** of complexity, risk, ambiguity, and independent packages. This version does not inspect a repository or classify a natural-language request automatically. Execution commands enforce configured attempt and worker limits. A small direct task stays on the current Codex conversation model.

`doctor` checks the installed CLI without starting a model turn or modifying configuration. An old or missing Codex CLI causes a diagnostic exit code of 1; offline planning still works. App Server detection is only a prerequisite check, not a verified integration.

Full setup, checksum, upgrade, removal, and source instructions are in the [installation guide](docs/INSTALLATION.md).

## Manage the project skill

Inspect, upgrade, or remove a project installation:

```sh
orqestra skill-status --project /absolute/path/to/your-project
orqestra upgrade-skill --project /absolute/path/to/your-project
orqestra uninstall-skill --project /absolute/path/to/your-project
```

Upgrades and removal verify every manifest-owned artifact. They refuse local changes, added files, symlinks, or unrecognized ownership rather than overwrite them. A schema 1 policy can be upgraded separately:

```sh
orqestra migrate-config --config /absolute/path/to/orqestra.config.json
```

Migration keeps the original as `orqestra.config.json.v1.bak`. Skill removal leaves policies and backups in place.

## Discover models

```sh
orqestra models --json
orqestra models --config orqestra.config.json --output catalog.json
orqestra plan --task examples/task.json --catalog catalog.json
```

Use `--codex /path/to/codex` if the default CLI is incompatible. A native executable or the official package's `bin/codex.js` entrypoint is supported. Model discovery uses the existing runtime/account state; it never requests login or starts a model turn. Account emails and credentials are excluded from reports. The Codex process can maintain its own normal logs/caches.

See [configuration and command documentation](docs/CONFIGURATION.md) and [tested compatibility](docs/COMPATIBILITY.md). The alpha is distributed as a versioned GitHub release archive and is not published to the npm registry.

## Run a durable verified worker

Create an execution contract from [examples/execution.json](examples/execution.json), use a disposable clean Git repository or worktree, then run:

```sh
node dist/src/cli.js run \
  --request /absolute/path/to/execution.json \
  --project /absolute/path/to/project \
  --config /absolute/path/to/orqestra.config.json
```

This creates a checkpoint under the repository's private Git metadata, starts a Codex worker with project-only writes and no network, and runs the declared checks independently. Failed verification can start a repair turn up to the policy's `maxAttempts`. Every check must pass before the result says `succeeded`.

If the App Server connection ends unexpectedly, `run` returns `paused` with a run ID. Resume with the same project, request, and policy:

```sh
node dist/src/cli.js resume \
  --run-id <id-from-run-report> \
  --request /absolute/path/to/execution.json \
  --project /absolute/path/to/project \
  --config /absolute/path/to/orqestra.config.json
```

Resume verifies detected edits before starting another turn and reopens the saved Codex thread for any repair. Approval requests are cancelled and reported by the CLI; Orqestra never grants them automatically. See [durable worker execution](docs/EXECUTION.md) for checkpoints, recovery, evidence, and failure behavior.

## Coordinate independent packages

Create a strict multi-package contract from [examples/coordination.json](examples/coordination.json), then run:

```sh
node dist/src/cli.js coordinate \
  --request /absolute/path/to/coordination.json \
  --project /absolute/path/to/project \
  --config /absolute/path/to/orqestra.config.json
```

Orqestra creates one detached worktree per package, waits for declared dependencies, enforces total and premium worker limits, commits only verified in-scope package changes, and assembles them in a separate integration worktree. The original checkout remains unchanged. Success requires every final integration check to pass; the report gives the verified worktree path for review.

Use `coordinate-resume` with the reported run ID after a paused transport. Committed packages are not repeated. See [independent parallel work](docs/COORDINATION.md) for contract rules, scheduling, recovery, and integration behavior.

## Inspect usage and evaluate paired runs

```sh
node dist/src/cli.js usage --json
node dist/src/cli.js benchmark --input examples/benchmark.template.json --json
```

Worker reports keep input, cached input, cache-write input, output, reasoning-output, and total token categories when App Server exposes them. Missing or interrupted telemetry is reported as a visibility gap. ChatGPT account observations remain account-wide and are never converted to API cost; API-key reports do not invent organization billing data. The main Codex conversation remains outside the helper's visibility.

The benchmark command accepts direct Codex and Orqestra observations tied to the same task contract and Git base commit. It reports completion, verification, regressions, retries, elapsed time, and only fully paired measured token or API-cost differences. See [usage accounting and paired evaluation](docs/ACCOUNTING_AND_EVALUATION.md).

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for milestone acceptance criteria.

## License

MIT. See [LICENSE](LICENSE).
