---
name: orqestra
description: Preview a coding task's route and model assignments using an Orqestra policy, discover Codex models, or diagnose prerequisites. Use for Orqestra configuration and routing previews. This early version does not execute workers.
---

# Orqestra policy previews

Use `node <this-skill-directory>/scripts/orqestra.mjs` as the helper command (called `orqestra` below). The project installation bundles its runtime, so no global npm package is required. A source checkout must first be built. Node.js 22 or newer is required.

- `orqestra --help` lists the supported commands. `orqestra demo --json` demonstrates routing without credentials or project edits.
- For setup, create a policy with `orqestra init --profile balanced --config <path>`. Economy and Quality are alternatives. The helper refuses to overwrite existing files. Keep existing project instructions and Codex settings intact.
- For a task preview, inspect only enough relevant repository context to assess scope, risk, ambiguity, and independence. Write a JSON assessment containing `objective`, `complexity` (`small`, `standard`, `complex`), `risk` (`low`, `high`), `ambiguity` (`clear`, `unclear`), and `independentPackages` (1 unless packages are independently completable).
- Call `orqestra plan --task <assessment.json> --config <policy.json> --json`. Keep temporary assessment files in a local ignored directory or temporary workspace. The assessment is your judgment; the helper does not inspect the repository or classify natural language.
- Explain the route, proposed models, verification depth, and material assumptions. Small high-risk changes still need critical review. Resolve ambiguity before any later implementation.
- `orqestra doctor --json` checks the CLI prerequisite without signing in, updating software, or starting a model turn. A detected App Server command does not prove protocol compatibility or account availability.
- `orqestra models --json` initializes a local Codex App Server and reads account mode and model settings. It does not log in or start turns. Use `--codex <executable>` to select a compatible CLI; JavaScript entrypoints are supported. Export a policy-filtered catalog with `models --config <policy.json> --output <catalog.json>`. Existing files are not overwritten. Do not treat listed models as guaranteed authorization, or configured role capabilities as measured quality.

Task plans are previews. Do not launch workers and attribute them to this helper, claim limits were enforced, or report measured savings. The selected main Codex model remains unchanged. Discovery is read-only at the protocol level; the Codex process may maintain its own normal caches/logs. Live worker execution remains an upcoming milestone.
