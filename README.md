# Orqestra

Configurable orchestration for coding work inside Codex.

Orqestra is being built to choose suitable models, keep worker context focused, and make execution and usage easier to understand. The intended interface is a Codex skill with guided setup, backed by a local helper.

**Status: offline planning foundation.** Configuration, model policies, route previews, a credential-free demo, and CLI diagnostics are implemented. Live worker execution, measured savings, model discovery, and a supported end-user installer are not available yet.

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

The first planning skill is in [skills/orqestra/SKILL.md](skills/orqestra/SKILL.md). It uses the same helper for previews. Guided skill installation is part of M2/M7. For a developer trial, build and pack the project, install that local package, then install the skill folder through your normal Codex skill workflow. Restart/reload skill discovery as required by your Codex version.

```sh
npm pack
# Use the exact .tgz path printed by npm pack:
npm install --global ./mobarakat313-orqestra-0.1.0-dev.0.tgz
orqestra demo
```

The package is not published to npm. No global installation is performed by the commands in the quickstart above. See [configuration and command documentation](docs/CONFIGURATION.md) for custom models and recorded catalogs.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for milestone acceptance criteria.

## License

MIT. See [LICENSE](LICENSE).
