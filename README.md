# Orqestra

Configurable orchestration for coding work inside Codex.

Orqestra is being built to choose suitable models, keep worker context focused, and make execution and usage easier to understand. The intended interface is a Codex skill with guided setup, backed by a local helper.

**Status: early development.** The implementation plan is in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). Live worker execution, measured savings, and a supported end-user installer are not available yet.

## Direction

- Economy, Balanced, Quality, and custom model policies.
- Role definitions independent of model names, including GPT-5.6 and GPT-6 Astra presets.
- Direct work for small tasks; delegation when it has a concrete benefit.
- Bounded retries, targeted verification, resumable work, and honest usage reporting.
- Compatibility checks before live execution, with no silent switch from subscription usage to API billing.

The [research and design discussion](docs/RESEARCH_AND_DIRECTION.md) explains the rationale and what was inspected. The project contains original implementation; third-party reference checkouts are not distributed.

## Development

The first milestone targets Node.js 22. Later milestones add guided installation inside Codex.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for milestone acceptance criteria.

## License

MIT. See [LICENSE](LICENSE).
