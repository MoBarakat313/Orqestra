# Orqestra roadmap

Orqestra is a public alpha. This roadmap records product direction rather than delivery dates or performance promises. Behavior described as available is backed by the repository's automated checks; live model availability still depends on the user's Codex installation and account.

## Available in the public alpha

- Configurable Economy, Balanced, Quality, and custom policies with model-independent roles.
- Direct, single-worker, planned, and coordinated routing from an explicit task assessment.
- Read-only Codex model discovery and runtime diagnostics.
- Durable bounded worker execution with independent verification and resume.
- Isolated package coordination with dependency scheduling, worker limits, and deterministic integration.
- Worker usage reporting with explicit visibility gaps, reproducible paired-evaluation records, and an automated isolated paired runner for single-worker tasks.
- Versioned project setup, configuration migration, integrity-checked upgrades, and reversible removal.

The supported commands and their current limits are documented in [CONFIGURATION.md](CONFIGURATION.md). Tested runtime and platform evidence is recorded in [COMPATIBILITY.md](COMPATIBILITY.md).

## Current priorities

1. Gather public-alpha feedback on installation, task contracts, routing decisions, and recovery messages.
2. Expand live compatibility evidence for interruption, cancellation, resume, and coordinated execution paths.
3. Make model and limit configuration easier inside Codex while preserving strict validation and existing project data.
4. Run and publish reproducible multi-task paired benchmarks before making numerical token, quality, or cost-savings claims.
5. Add runtime adapters only when discovery, execution, permissions, recovery, and usage boundaries can be tested end to end.

## Design commitments

- Keep orchestration roles independent of model names so future compatible models can be configured without router changes.
- Preserve project instructions, user edits, authentication state, and existing Codex configuration.
- Keep routing, limits, state transitions, verification, and reporting deterministic where practical.
- Distinguish implemented, simulated, measured, and planned behavior.
- Treat model availability and supported reasoning settings as runtime facts, not assumptions from a preset.
- Prefer focused work and bounded retries over unnecessary worker creation.

Feature requests and defects are welcome through [GitHub Issues](https://github.com/MoBarakat313/Orqestra/issues). Security reports should follow [SECURITY.md](../SECURITY.md).
