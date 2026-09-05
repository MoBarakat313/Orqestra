# Configuration and commands

The helper currently plans work offline. It does not dispatch workers, discover live models, collect usage, or change Codex settings. Examples use `orqestra`; from a source checkout run `npm run build` and substitute `node dist/src/cli.js`.

## Commands

| Command | Behavior |
| --- | --- |
| `orqestra init --profile balanced` | Create `orqestra.config.json` in the current directory; refuse to overwrite any existing file. |
| `orqestra validate --config policy.json` | Strictly validate configuration and model/role references. Does not establish account availability. |
| `orqestra plan --task task.json --config policy.json` | Print a route and model-assignment preview from an explicit assessment. |
| `orqestra plan --task task.json --catalog catalog.json` | Also filter candidates against a recorded catalog. |
| `orqestra demo --profile economy` | Show four offline scenarios; write no files and make no model calls. |
| `orqestra doctor --codex /path/to/codex` | Check version/root help with timeouts; explain missing or incompatible CLI prerequisites. |

All commands accept `--json`. Success output goes to stdout; input/operation errors go to stderr as `{ "error": "..." }` in JSON mode. Failed diagnostics print their structured diagnostic report to stdout and exit 1. Other failed commands also exit 1. Commands reject unrelated flags rather than silently ignoring them.

`init` accepts Economy, Balanced, or Quality (lowercase in the CLI). For a custom policy, generate one and edit its `profile` to `custom` plus its model/role bindings. Profiles are labels on explicit policy data; the router never branches on a profile name.

## Model declarations and role bindings

Each model alias has an `id`, `runtime`, `group` (`standard` or `premium`), supported `reasoningEfforts`, and `capabilities` (`read`, `code`, `plan`, `review`). Roles are `explore`, `implement`, `plan`, `review`, and `escalate`; each lists ordered `{ "model": "alias", "reasoning": "medium" }` candidates.

The router selects the first eligible configured candidate. Later candidates are explicit availability/policy fallbacks, not failure-retry instructions. Failure-based escalation is a later milestone; the `escalate` role reserves its policy. `explore` is also a reserved role and is not automatically scheduled by offline plans.

New model IDs, runtime names, and reasoning strings can be added through configuration. That proves policy extensibility, not that an execution adapter exists for that runtime. Declared capabilities and prices are not intelligence scores. Prices are intentionally absent from this initial schema.

The starter policies use GPT-5.6 Luna/Terra/Sol and GPT-6 Astra, based on [official model documentation](https://developers.openai.com/api/docs/models). Codex availability and supported reasoning must be rechecked against the actual runtime before future execution. Astra does not declare `none` reasoning in the preset. Presets are editable starting points, not optimal or benchmarked recommendations.

## Explicit task assessments

```json
{
  "objective": "Add an export action to the reports screen",
  "complexity": "standard",
  "risk": "low",
  "ambiguity": "clear",
  "independentPackages": 1
}
```

- `complexity`: `small`, `standard`, or `complex`.
- `risk`: `low` or `high`; risk is independent of task size.
- `ambiguity`: `clear` or `unclear`; unclear scope requires planning before any future implementation.
- `independentPackages`: 1–16. Use more than 1 only when work has independent boundaries; a file count is not a package count.
- `objective`: nonempty single-line text without control characters.

Small, clear, low-risk work with one package uses `direct` and assigns no worker. Standard work uses `single`. Complex, high-risk, unclear, or multi-package work requires planning. Multiple packages use `coordinated` only when the selected implementation model's configured capacity allows parallelism; otherwise they stay `planned` and sequential.

Verification is `focused`, `targeted-review`, or `critical-review`. High-risk work always receives critical review. Plans list one assignment per stage; `parallelWorkers` is the proposed implementation concurrency, not the number of all listed stages running together. Planning precedes implementation, and review follows it.

## Limits and truthfulness

`maxWorkers` is 1–16, `maxPremiumWorkers` is 0–`maxWorkers`, and `maxAttempts` is 1–5. These are Orqestra schema bounds, not claims about the host platform's limits. M1 uses them for selection and previews; M3–M5 will add dispatch/retry enforcement. Setting premium capacity to zero makes premium candidates ineligible; missing approved alternatives result in an error.

Without a catalog, plans report `availability: "unverified"`. All plans have `mode: "preview"` and `usage: null`. None reports avoided tokens, saved allowance, or API dollars. The main Codex session's model is not switched by this helper.

## Recorded catalogs

An optional JSON snapshot has `schemaVersion: 1`, `observedAt` (UTC ISO timestamp), and `models`. Each entry contains `id`, `runtime`, `reasoningEfforts`, and `capabilities`. An empty model list is valid and makes worker selection fail rather than assume access. The timestamp is shown in the result; a supplied snapshot is not fresh account verification.

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-09-05T12:00:00Z",
  "models": [
    {
      "id": "example-model",
      "runtime": "example-runtime",
      "reasoningEfforts": ["medium"],
      "capabilities": ["read", "code"]
    }
  ]
}
```

This example is fictitious and does not claim any account access. A catalog must match both runtime and model ID and support the configured effort and role capability. Missing matches never cause an implicit switch to another provider or billing mode.

## Schema compatibility

Unknown fields, unsupported versions, missing required fields, duplicate identities/candidates, invalid limits, and unsupported declared role settings are errors. JSON input files must be at most 1 MiB. Future incompatible schemas will need explicit migration; M1 does not silently migrate or rewrite files.
