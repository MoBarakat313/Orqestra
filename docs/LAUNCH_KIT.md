# Orqestra public alpha launch kit

Use this page to try Orqestra quickly, explain its routing approach accurately, and share the public alpha with potential testers.

## Start in 60 seconds

The hands-on setup takes about one minute. Codex may need additional time to download, verify, install, and diagnose the release.

1. Confirm that [Node.js 22 or newer](https://nodejs.org/en/download) and npm are installed.
2. Open the project where you want to use Orqestra in Codex Desktop.
3. Copy and paste the single prompt under [Quick installation](../README.md#quick-installation).
4. Open or reload the project if Codex asks. Orqestra should appear in the project's Skills section.
5. Paste the routing example below into Codex.

Codex verifies the versioned release archive and checksum before installing it. The detailed procedure, expected files, and troubleshooting steps are in [QUICK_INSTALL.md](QUICK_INSTALL.md).

## Try one simple routing example

Paste this into Codex after installation:

```text
$orqestra preview a plan for adding CSV export to one existing package, including tests. Do not change files.
```

For a clear change contained in one package, the expected recommendation is usually:

| Decision | Illustrative result |
| --- | --- |
| Route | Single worker |
| Additional implementation workers | 1 |
| Why | The change is clear, bounded, low risk, and does not contain independent packages that justify coordination. |
| Verification | Run the package's declared deterministic checks after implementation. |

This is an example, not a forced result. Orqestra records the assessment and can choose direct work, planning, or coordinated workers when the task and repository evidence support a different route.

## Show the Safe Token behavior

![Illustrative Orqestra Safe Token routing: selected Astra work with bounded Luna or Terra implementation instead of using Astra for every step](https://raw.githubusercontent.com/MoBarakat313/Orqestra/main/.github/assets/orqestra-safe-token-strategy.png)

Safe Token means controlling avoidable orchestration work: direct execution for small tasks, focused worker context, configurable model roles, hard worker limits, bounded retries, and deterministic verification that does not start another model turn.

The visual is illustrative. It does not show measured token counts or promise a savings percentage. Orqestra does not make GPT-6 Astra consume fewer tokens; it controls where and when configured models and additional workers are used. Actual usage depends on the task, context, policy, retries, available account models, and the telemetry exposed by Codex.

## What useful alpha feedback includes

- Orqestra version, operating system, Node.js version, and Codex CLI version.
- A sanitized description of the task and repository shape.
- The selected route and whether it matched the tester's expectation.
- The command or prompt that failed, plus the smallest safe reproduction.
- The expected and actual result.
- Whether the installation, diagnostics, recovery message, and next action were understandable.

Use the [public alpha feedback form](https://github.com/MoBarakat313/Orqestra/issues/new?template=alpha-feedback.yml) for general testing results or the [bug report form](https://github.com/MoBarakat313/Orqestra/issues/new?template=bug.yml) for a reproducible defect. Remove credentials, account details, private source, and full Codex logs before submitting.
