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

## Use Orqestra in Codex Desktop

The public alpha requires [Node.js 22 or newer](https://nodejs.org/en/download) and npm. Install it once, then run setup in every project where you want Codex to find the Orqestra skill.

### 1. Download, verify, and install

Download `mobarakat313-orqestra-0.1.0-alpha.1.tgz` and `SHA256SUMS.txt` from the [v0.1.0-alpha.1 release](https://github.com/MoBarakat313/Orqestra/releases/tag/v0.1.0-alpha.1).

On macOS, run these commands in the download directory:

```sh
shasum -a 256 -c SHA256SUMS.txt
npm install --global ./mobarakat313-orqestra-0.1.0-alpha.1.tgz
orqestra version
```

On Linux, replace the first command with `sha256sum -c SHA256SUMS.txt`. On Windows PowerShell, verify and install with:

```powershell
$archive = ".\mobarakat313-orqestra-0.1.0-alpha.1.tgz"
$expected = (Get-Content .\SHA256SUMS.txt).Split()[0].ToLower()
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA-256 checksum does not match" }
npm install --global $archive
orqestra version
```

### 2. Add Orqestra to a project

Use the project's absolute path in a normal terminal or the Codex terminal:

```sh
orqestra setup --project /absolute/path/to/your-project --profile balanced
```

Setup creates:

- `orqestra.config.json`, the editable model and execution policy.
- `.agents/skills/orqestra/`, the self-contained skill that Codex discovers for this project.

Setup preserves existing project instructions, Codex settings, and unrelated skills. It is safe to repeat on a pristine Orqestra installation.

### 3. Open the project in Codex Desktop

Open or reload the project after setup. Orqestra should appear in the Skills section of the Codex sidebar. If it does not appear, reload or restart Codex and run:

```sh
orqestra skill-status --project /absolute/path/to/your-project
orqestra doctor
```

### 4. Ask Codex to use Orqestra

Start the prompt with `$orqestra`. For example:

```text
$orqestra preview a plan for adding CSV export to this project, including tests.
```

Preview inspects enough project context to assess the task, writes a temporary structured assessment, and explains the proposed route, model roles, verification depth, and assumptions. It does not implement the task.

When the plan is suitable, ask Codex to execute it:

```text
$orqestra implement the CSV export using the Balanced profile and verify the result.
```

Other useful prompts include:

```text
$orqestra show which Codex models are available for this project and validate the policy.

$orqestra resume run <run-id> using the same task contract.

$orqestra coordinate these independent packages: update the API in packages/api and the client in packages/client, then run the repository checks.
```

Orqestra keeps a small, clear, low-risk task in the current Codex conversation. A standard clear task can use one bounded worker. Work is coordinated in isolated worktrees only when the packages are independently completable and have explicit, nonoverlapping ownership. Ambiguous or high-risk work stays at planning until its contract is clear.

### 5. Check prerequisites or try the offline demo

No API key or Codex account is needed for the helper's offline demo:

```sh
orqestra demo
orqestra doctor
```

`doctor` checks the installed CLI without signing in, starting a model turn, changing configuration, or installing software. When it succeeds, inspect the models exposed by the existing Codex account:

```sh
orqestra models
```

Live `run` and `coordinate` commands require a compatible Codex CLI with App Server access through the user's existing account. Codex Desktop being installed does not by itself prove that this CLI is available on `PATH`; `doctor` reports the detected state. The helper's offline demo and route calculation still work when that check fails.

The task assessment remains explicit: this version does not classify an arbitrary natural-language request without Codex first inspecting the project and recording its judgment. Configuration declarations do not prove account availability, and previews are not execution or savings evidence.

Full upgrade, migration, removal, troubleshooting, and source instructions are in the [installation guide](docs/INSTALLATION.md). Codex project-skill discovery is described in the [official skills documentation](https://learn.chatgpt.com/docs/build-skills).

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
