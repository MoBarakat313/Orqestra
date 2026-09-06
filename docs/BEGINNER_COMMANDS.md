# Orqestra commands for beginners

Orqestra has two command styles:

- In **Codex chat**, begin a request with `$orqestra`. Codex reads the project, creates the structured input needed by the helper, and explains the result.
- In a **terminal**, begin a command with `orqestra`. Terminal commands are useful for diagnostics, automation, and advanced execution contracts.

Replace placeholders such as `<project>` and `<run-id>` with real values. Paths containing spaces are supported.

## Everyday Codex prompts

### Preview before making changes

```text
$orqestra preview a plan for adding CSV export to this project, including tests.
```

Preview reports the route, proposed model roles, verification depth, and assumptions. It does not implement the task.

### Implement a clear task

```text
$orqestra implement the CSV export using the current project policy and verify the result.
```

A small task can stay in the current Codex conversation. A standard, clear, low-risk task can use one bounded worker when the execution contract and repository meet the documented requirements.

### Check installation and runtime health

```text
$orqestra check this project's installation status and run diagnostics.
```

Terminal equivalents:

```sh
orqestra skill-status --project /absolute/path/to/project
orqestra doctor
```

`skill-status` verifies the installed project files. `doctor` checks Node.js and the Codex CLI without signing in, changing configuration, starting a model turn, or installing software.

## Profiles, models, and configuration

### Choose a profile during first setup

```sh
orqestra setup --project /absolute/path/to/project --profile balanced
```

The available initial profiles are:

| Profile | Default implementation | Planning and review | Good starting point for |
| --- | --- | --- | --- |
| Economy | GPT-5.6 Luna at medium reasoning | GPT-5.6 Terra | Routine work using standard model roles |
| Balanced | GPT-5.6 Terra at medium reasoning | GPT-5.6 Sol | The default mix of standard and premium roles |
| Quality | GPT-5.6 Sol at high reasoning | GPT-6 Astra | Premium implementation, planning, and review roles |

These are editable policy defaults. They are not measured rankings or proof of access to those models.

### See available models without changing anything

```text
$orqestra show the models available to my Codex account and explain the current role assignments. Do not change anything.
```

Terminal equivalent:

```sh
orqestra models --json
```

Model discovery reads the existing Codex account and starts no model turn. A listed model can still fail later authorization, and an unlisted configured model should not be assumed available.

### Change the model used by one role

```text
$orqestra change the implement role to GPT-6 Astra with high reasoning. Change only orqestra.config.json, validate it, and show the exact change.
```

Use `explore`, `implement`, `plan`, `review`, or `escalate` as the role. Ask for model discovery first when you do not know which models and reasoning settings are available.

### Change worker and retry limits

```text
$orqestra set this project to at most 3 workers, 1 premium worker, and 2 attempts. Change only orqestra.config.json, validate it, and show the exact change.
```

The configuration fields are `maxWorkers`, `maxPremiumWorkers`, `maxAttempts`, and `turnTimeoutSeconds`. The validator enforces their allowed ranges.

### Validate the policy

```sh
orqestra validate --config /absolute/path/to/project/orqestra.config.json
```

The current alpha has no interactive `configure` terminal command. Edit `orqestra.config.json` directly or ask `$orqestra` to make one focused change, then validate it. Validation proves that the policy is structurally consistent; it does not prove account availability or model quality. Changing this policy does not change the model selected for the main Codex conversation.

## Run, resume, and coordinate work

Most beginners should ask `$orqestra` to create the required task assessment and execution contract. The lower-level terminal commands accept strict JSON files.

### Run one verified worker

```sh
orqestra run \
  --request /absolute/path/to/execution.json \
  --project /absolute/path/to/project \
  --config /absolute/path/to/project/orqestra.config.json
```

Use this only for a disposable clean Git repository or worktree and a task that routes to one standard worker. Every declared verification command must pass before Orqestra reports success.

### Resume a paused worker

```text
$orqestra resume run <run-id> using the same task contract.
```

Terminal equivalent:

```sh
orqestra resume \
  --run-id <run-id> \
  --request /absolute/path/to/execution.json \
  --project /absolute/path/to/project \
  --config /absolute/path/to/project/orqestra.config.json
```

Use the same request, project, and policy. Do not start a new run over edits from a paused run.

### Coordinate independent packages

```text
$orqestra coordinate these independent packages: update packages/api and packages/client, then run the repository checks.
```

Terminal execution uses `orqestra coordinate`; paused coordination uses `orqestra coordinate-resume`. Each package needs explicit nonoverlapping path ownership and dependencies. Successful output remains in a separate verified integration worktree for review.

## Usage and evaluation

### Inspect visible usage

```text
$orqestra inspect the available account and worker usage information and explain any visibility gaps.
```

Terminal equivalent:

```sh
orqestra usage --json
```

Account limits are account-wide. Worker token reports cover only attempts observed through Orqestra. The main Codex conversation remains outside the helper's usage visibility.

### Evaluate paired runs

```sh
orqestra benchmark --input /absolute/path/to/benchmark.json --json
```

Benchmarking compares recorded direct Codex and Orqestra runs only when they share the same task contract and Git base. It does not estimate missing runs or claim savings from a preview.

## Update or remove Orqestra

### Check the installed project skill

```sh
orqestra version
orqestra skill-status --project /absolute/path/to/project
```

### Upgrade after installing a newer release archive

```sh
orqestra upgrade-skill --project /absolute/path/to/project
```

This upgrades the project skill from the currently installed Orqestra package. It does not download a release. Install the new verified release archive first. Modified or unrecognized project installations are preserved and reported instead of overwritten.

### Remove Orqestra from one project

```sh
orqestra uninstall-skill --project /absolute/path/to/project
```

This removes only an unchanged, manifest-owned project skill. It leaves `orqestra.config.json`, migration backups, project instructions, Codex settings, and unrelated skills in place.

### Remove the global command

```sh
npm uninstall --global @mobarakat313/orqestra
```

Remove project skills before the global command when you no longer want Orqestra in those projects.

## Complete terminal command index

| Command | What it does |
| --- | --- |
| `orqestra version` | Shows the installed Orqestra version. |
| `orqestra setup` | Creates or migrates a project policy and installs or safely upgrades its skill. |
| `orqestra init` | Creates a new policy file and refuses to overwrite an existing file. |
| `orqestra migrate-config` | Migrates a recognized older policy and preserves its original backup. |
| `orqestra validate` | Checks policy structure, limits, models, roles, and reasoning declarations. |
| `orqestra plan` | Calculates a route from an explicit JSON task assessment without implementing it. |
| `orqestra demo` | Shows offline example routes without credentials or project changes. |
| `orqestra doctor` | Diagnoses Node.js and Codex CLI prerequisites. |
| `orqestra models` | Reads available Codex model IDs and reasoning settings without starting a turn. |
| `orqestra run` | Runs one bounded worker and independent verification. |
| `orqestra resume` | Continues the matching paused single-worker run. |
| `orqestra coordinate` | Runs independent packages in isolated worktrees and verifies integration. |
| `orqestra coordinate-resume` | Continues matching paused package runs without repeating committed packages. |
| `orqestra usage` | Reads bounded account-level observations without starting a model turn. |
| `orqestra benchmark` | Evaluates recorded direct Codex and Orqestra pairs. |
| `orqestra install-skill` | Installs the project skill without creating a policy. `setup` is easier for new users. |
| `orqestra skill-status` | Verifies project-skill ownership, version, and file integrity. |
| `orqestra upgrade-skill` | Safely upgrades a pristine project skill from the installed package. |
| `orqestra uninstall-skill` | Safely removes an unchanged project skill. |

Every command accepts `--json`. Run `orqestra --help` for exact syntax. Read [configuration and commands](CONFIGURATION.md) for the full technical contract, [durable worker execution](EXECUTION.md) for run boundaries, and [independent parallel work](COORDINATION.md) for package coordination.
