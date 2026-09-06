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

## Quick installation with Codex

The public alpha requires [Node.js 22 or newer](https://nodejs.org/en/download) and npm. Open the project you want to use in Codex Desktop, then paste this as one prompt:

```text
Install Orqestra in the project currently open in Codex from the latest release at https://github.com/MoBarakat313/Orqestra/releases.

First check that Node.js 22 or newer and npm are available. If either is missing, stop and explain what I need to install; do not install or upgrade Node.js, npm, or Codex automatically.

Download only the versioned mobarakat313-orqestra-<version>.tgz release asset and SHA256SUMS.txt into a temporary directory. Do not use GitHub's Source code archive. Verify the archive against SHA256SUMS.txt and stop if verification fails.

Install the verified archive globally with npm without sudo. Then run Orqestra setup for the currently open project using the Balanced profile. Verify the installation with skill-status and run doctor. Report a doctor compatibility failure separately; it does not mean that project installation failed.

Preserve all existing project instructions, skills, Codex settings, configuration, and user files. Remove the temporary download files when finished. Report the installed version, files added to the project, doctor result, and whether Codex needs to be reloaded.
```

The prompt authorizes installation of the verified Orqestra package and setup of the currently open project. Codex should stop and explain the problem if a prerequisite, checksum, package installation, or project integrity check fails. See the [quick-install procedure](docs/QUICK_INSTALL.md) for the expected result.

## Manual installation

Prefer to run each command yourself? The [manual installation guide](docs/INSTALLATION.md) has separate macOS, Linux, and Windows PowerShell instructions, including checksum verification, project setup, troubleshooting, upgrades, and removal.

After either installation path, open or reload the project. Orqestra should appear in the Skills section of the Codex sidebar. Setup creates `orqestra.config.json` and `.agents/skills/orqestra/` while preserving existing project instructions, Codex settings, and unrelated skills.

**Next: [learn the important Orqestra commands](#important-commands-for-beginners).**

## Important commands for beginners

Use prompts beginning with `$orqestra` in Codex chat. Use commands beginning with `orqestra` in a terminal.

| What you want | Paste into Codex |
| --- | --- |
| Preview a task safely | `$orqestra preview a plan for adding CSV export, including tests.` |
| Implement and verify | `$orqestra implement the CSV export using the current project policy and verify the result.` |
| Check installation health | `$orqestra check this project's installation status and run diagnostics.` |
| See available models | `$orqestra show the models available to my Codex account and explain the current role assignments. Do not change anything.` |
| Change a role's model | `$orqestra change the implement role to GPT-6 Astra with high reasoning. Change only orqestra.config.json, validate it, and show the exact change.` |
| Change worker limits | `$orqestra set this project to at most 3 workers and 1 premium worker. Change only orqestra.config.json and validate it.` |
| Resume interrupted work | `$orqestra resume run <run-id> using the same task contract.` |
| Coordinate independent work | `$orqestra coordinate these independent packages: update packages/api and packages/client, then run the repository checks.` |
| Inspect visible usage | `$orqestra inspect the available account and worker usage information and explain any visibility gaps.` |

For model or limit changes, Orqestra first checks the current policy and validates the edited file. The alpha does not have an interactive `configure` terminal command. Configuration declarations do not prove that a model is available, so use model discovery before live execution. Orqestra never changes the model selected for the main Codex conversation.

The [beginner command guide](docs/BEGINNER_COMMANDS.md) explains profiles, model changes, status checks, updates, removal, execution, recovery, usage, and every terminal command included in the alpha.

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
orqestra run \
  --request /absolute/path/to/execution.json \
  --project /absolute/path/to/project \
  --config /absolute/path/to/orqestra.config.json
```

This creates a checkpoint under the repository's private Git metadata, starts a Codex worker with project-only writes and no network, and runs the declared checks independently. Failed verification can start a repair turn up to the policy's `maxAttempts`. Every check must pass before the result says `succeeded`.

If the App Server connection ends unexpectedly, `run` returns `paused` with a run ID. Resume with the same project, request, and policy:

```sh
orqestra resume \
  --run-id <id-from-run-report> \
  --request /absolute/path/to/execution.json \
  --project /absolute/path/to/project \
  --config /absolute/path/to/orqestra.config.json
```

Resume verifies detected edits before starting another turn and reopens the saved Codex thread for any repair. Approval requests are cancelled and reported by the CLI; Orqestra never grants them automatically. See [durable worker execution](docs/EXECUTION.md) for checkpoints, recovery, evidence, and failure behavior.

## Coordinate independent packages

Create a strict multi-package contract from [examples/coordination.json](examples/coordination.json), then run:

```sh
orqestra coordinate \
  --request /absolute/path/to/coordination.json \
  --project /absolute/path/to/project \
  --config /absolute/path/to/orqestra.config.json
```

Orqestra creates one detached worktree per package, waits for declared dependencies, enforces total and premium worker limits, commits only verified in-scope package changes, and assembles them in a separate integration worktree. The original checkout remains unchanged. Success requires every final integration check to pass; the report gives the verified worktree path for review.

Use `coordinate-resume` with the reported run ID after a paused transport. Committed packages are not repeated. See [independent parallel work](docs/COORDINATION.md) for contract rules, scheduling, recovery, and integration behavior.

## Inspect usage and evaluate paired runs

```sh
orqestra usage --json
orqestra benchmark --input /absolute/path/to/benchmark.json --json
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
