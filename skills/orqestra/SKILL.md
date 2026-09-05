---
name: orqestra
description: Preview a coding task's execution route and model assignments using an installed Orqestra policy, or diagnose its local Codex prerequisites. Use for Orqestra setup, profile configuration, and routing previews. This early version does not execute workers.
---

# Orqestra policy previews

Use the installed `orqestra` helper; if it is unavailable, explain that the development package must first be built and installed from the Orqestra repository. Do not treat the source checkout as an installed executable.

- `orqestra --help` lists the supported commands. `orqestra demo --json` demonstrates routing without credentials or project edits.
- For setup, create a policy with `orqestra init --profile balanced --config <path>`. Economy and Quality are alternatives. The helper refuses to overwrite existing files. Keep existing project instructions and Codex settings intact.
- For a task preview, inspect only enough relevant repository context to assess scope, risk, ambiguity, and independence. Write a JSON assessment containing `objective`, `complexity` (`small`, `standard`, `complex`), `risk` (`low`, `high`), `ambiguity` (`clear`, `unclear`), and `independentPackages` (1 unless packages are independently completable).
- Call `orqestra plan --task <assessment.json> --config <policy.json> --json`. Keep temporary assessment files in a local ignored directory or temporary workspace. The assessment is your judgment; the helper does not inspect the repository or classify natural language.
- Explain the route, proposed models, verification depth, and material assumptions. Small high-risk changes still need critical review. Resolve ambiguity before any later implementation.
- `orqestra doctor --json` checks the CLI prerequisite without signing in, updating software, or starting a model turn. A detected App Server command does not prove protocol compatibility or account availability.

All outputs are previews. Do not launch workers and attribute them to this helper, claim limits were enforced, or report measured savings. The selected main Codex model remains unchanged. The helper accepts optional recorded catalogs for policy filtering; live discovery, execution, and installation automation remain upcoming milestones.
