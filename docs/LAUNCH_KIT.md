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

## Reddit post

Suggested title:

```text
I built Orqestra, an open-source Codex orchestrator for bounded workers and transparent token usage — looking for alpha testers
```

Suggested post:

```text
I have been building Orqestra, an open-source orchestration helper that runs inside Codex Desktop with a small local TypeScript CLI.

The idea is to assess each task before creating extra workers. Small work can stay in the current Codex conversation, a clear one-package task can use one focused worker, unclear or higher-risk work can stop for planning, and genuinely independent packages can use bounded coordinated workers.

Orqestra also has configurable model policies. For example, a policy can reserve GPT-6 Astra for selected planning or review decisions while using another available model for bounded routine implementation. Model names are presets rather than hard-coded orchestration logic, so users can adjust policies as Codex models change.

I call the resource-control approach “Safe Token.” It does not make a model consume fewer tokens, and I am not claiming a fixed savings percentage. It aims to reduce avoidable model turns, oversized worker context, unnecessary swarms, and open-ended retries. Reports preserve token categories that Codex exposes and identify visibility gaps instead of estimating missing usage.

This is public alpha software (v0.1.0-alpha.2). The core has automated coverage and the release package is checked on Ubuntu, macOS, and Windows, but I need more real-world testing across different Codex installations, accounts, repositories, and task shapes.

If you would like to help, please try:

1. The one-prompt installation from the README.
2. `orqestra doctor` and read-only model discovery.
3. One `$orqestra` route preview.
4. A small implementation task in a disposable branch or test repository.

Please tell me your OS, Node.js and Codex versions, the sanitized task shape, the route Orqestra selected, what you expected, and any confusing setup or recovery message. Remove credentials, account details, private source, and full Codex logs before sharing feedback.

Repository: https://github.com/MoBarakat313/Orqestra
Release: https://github.com/MoBarakat313/Orqestra/releases/tag/v0.1.0-alpha.2
Alpha feedback: https://github.com/MoBarakat313/Orqestra/issues/new?template=alpha-feedback.yml

I would especially value feedback on whether the routing explanation is understandable and whether the installation feels approachable for people who do not work in a terminal every day.
```

## What useful alpha feedback includes

- Orqestra version, operating system, Node.js version, and Codex CLI version.
- A sanitized description of the task and repository shape.
- The selected route and whether it matched the tester's expectation.
- The command or prompt that failed, plus the smallest safe reproduction.
- The expected and actual result.
- Whether the installation, diagnostics, recovery message, and next action were understandable.

Use the [public alpha feedback form](https://github.com/MoBarakat313/Orqestra/issues/new?template=alpha-feedback.yml) for general testing results or the [bug report form](https://github.com/MoBarakat313/Orqestra/issues/new?template=bug.yml) for a reproducible defect. Remove credentials, account details, private source, and full Codex logs before submitting.
