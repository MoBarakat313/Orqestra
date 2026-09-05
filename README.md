# Orqestra

Configurable orchestration for coding work inside Codex.

Orqestra is being built to choose suitable models, keep worker context focused, and make execution and usage easier to understand. The intended interface is a Codex skill with guided setup, backed by a local helper.

**Status: development preview.** Configuration, model policies, route previews, an offline demo, read-only Codex model discovery, and project-local skill installation/removal are implemented. Live worker execution and measured savings are not available yet.

## Direction

- Economy, Balanced, Quality, and custom model policies.
- Role definitions independent of model names, including GPT-5.6 and GPT-6 Astra presets.
- Direct work for small tasks; delegation when it has a concrete benefit.
- Bounded retries, targeted verification, resumable work, and honest usage reporting.
- Compatibility checks before live execution, with no silent switch from subscription usage to API billing.

The [research and design discussion](docs/RESEARCH_AND_DIRECTION.md) explains the rationale and what was inspected. The project contains original implementation; third-party reference checkouts are not distributed.

## Try the development preview

Requires Node.js 22 or newer and npm. No API key or Codex account is needed for the offline demo.

```sh
git clone https://github.com/MoBarakat313/Orqestra.git
cd Orqestra
npm ci
npm run demo
```

Preview a task using a generated policy:

```sh
npm run build
node dist/src/cli.js init --profile balanced
node dist/src/cli.js plan --task examples/task.json
node dist/src/cli.js doctor
```

The task file contains an **explicit assessment** of complexity, risk, ambiguity, and independent packages. This version does not inspect a repository or classify a natural-language request automatically. Preview limits are not yet enforced by a dispatcher. A small direct task stays on the current Codex conversation model.

`doctor` checks the installed CLI without starting a model turn or modifying configuration. An old or missing Codex CLI causes a diagnostic exit code of 1; offline planning still works. App Server detection is only a prerequisite check, not a verified integration.

## Inside Codex

Install the skill into an existing project after building Orqestra:

```sh
node dist/src/cli.js install-skill --project /absolute/path/to/your-project
```

Open that project in Codex and ask **`$orqestra preview a plan for my task`**. Reload Codex if the skill does not appear. The installer creates `.agents/skills/orqestra/` with a self-contained helper and requires no global npm installation. Existing skills, project instructions, and Codex settings are preserved. Node.js 22 remains a prerequisite.

To remove an unchanged installation:

```sh
node dist/src/cli.js uninstall-skill --project /absolute/path/to/your-project
```

Removal refuses modified files, new artifacts, and unrecognized ownership. Preserve your changes before removing a customized installation. Automatic upgrades are not implemented.

## Discover models

```sh
node dist/src/cli.js models --json
node dist/src/cli.js models --config orqestra.config.json --output catalog.json
node dist/src/cli.js plan --task examples/task.json --catalog catalog.json
```

Use `--codex /path/to/codex` if the default CLI is incompatible. A native executable or the official package's `bin/codex.js` entrypoint is supported. Model discovery uses the existing runtime/account state; it never requests login or starts a model turn. Account emails and credentials are excluded from reports. The Codex process can maintain its own normal logs/caches.

See [configuration and command documentation](docs/CONFIGURATION.md) and [tested compatibility](docs/COMPATIBILITY.md). The package is not published to npm; source checkout and local `npm pack` installation are development paths.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for milestone acceptance criteria.

## License

MIT. See [LICENSE](LICENSE).
