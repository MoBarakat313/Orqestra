# Working on Orqestra

Orqestra's first interface is inside Codex, with a small local helper. Read `docs/ROADMAP.md` for current scope and priorities, then read the guide for the behavior you are changing.

- Keep orchestration policies independent of particular model names. Put model-specific defaults in presets and validate them at runtime boundaries.
- Keep the core deterministic and testable without credentials. Separate planning, dispatch, verification, and reporting.
- Preserve project instructions, user edits, authentication state, and existing Codex configuration. Do not install or upgrade global tools as a side effect of a diagnostic command.
- Report implemented, simulated, and planned behavior accurately. Configuration declarations are not evidence of account availability; simulated runs are not savings measurements.
- Do not copy `.references/` into source, releases, commits, or published packages.
- Keep generated files, credentials, local run data, and downloaded reference code out of Git.
- Update relevant command documentation and milestone status with behavior changes. Run `npm run check` when the TypeScript foundation is present.
- Use focused tests for routing boundaries, invalid configuration, runtime failures, and preservation of user data. Prefer isolated temporary fixtures to live model calls.
