# Usage accounting and paired evaluation

M6 records model usage that [Codex App Server](https://learn.chatgpt.com/docs/app-server) actually exposes and labels the parts it cannot observe. It does not infer subscription consumption, API cost, or hypothetical savings.

## Worker usage

`run`, `resume`, `coordinate`, and `coordinate-resume` reports include a `usage` object. For each completed worker turn, Orqestra reads `thread/tokenUsage/updated` and records:

- input tokens;
- cached input tokens;
- cache-write input tokens when the runtime exposes them, otherwise zero under the protocol's backward-compatible default;
- output tokens;
- reasoning output tokens, which remain a diagnostic subset of output rather than an added charge;
- total tokens.

Fresh threads use their cumulative thread total. A resumed repair uses the cumulative total before and after the turn so multiple model requests within that turn are included. If the runtime does not replay the pre-turn snapshot, Orqestra falls back to the final `last` breakdown and records that continuations may be missing. Interrupted turns and missing final notifications remain `unmeasured`; they are never treated as zero.

Durable reports sum attempt-local observations. Coordinated reports sum the persisted durable reports for every package. They do not sum cumulative thread totals directly, which would count earlier repair turns again. The deterministic integration owner starts zero model turns.

The main Codex conversation is outside the helper's App Server process. Its token usage is therefore `null` with `visibility: "outside-runtime"`. Orqestra does not subtract an unobserved coordinator estimate from observed worker tokens.

## Account and API modes

Read account-level observations without starting a model turn:

```sh
orqestra usage --json
```

For a ChatGPT account, the command requests `account/rateLimits/read` and `account/usage/read`. It reports rate-limit windows and token-activity summaries as account-wide observations. Other Codex work may change those values at the same time, so they are not attributed to an Orqestra run and are not converted to dollars.

For API-key mode, App Server does not provide organization API usage or billed cost through these methods. The report keeps `organizationUsage` and `cost` as `null` and explains that separately authorized API organization data would be required. Orqestra never calls a ChatGPT account-usage endpoint in API-key mode.

Optional account endpoints can be unavailable on a compatible runtime or account. In that case the command returns `partial` or `unavailable` with a bounded warning. Account emails, credentials, raw backend errors, and full responses are excluded.

## Automated paired benchmark

Use [the automated benchmark specification](../examples/benchmark-run.json) to run repeated direct Codex and Orqestra arms without changing the source checkout:

```sh
orqestra benchmark-run \
  --input /absolute/path/to/benchmark-run.json \
  --project /absolute/path/to/clean-project \
  --config /absolute/path/to/orqestra.config.json \
  --json
```

The task must route to one implementation worker. The runner discovers the live Codex catalog before starting turns, resolves the Orqestra implement role, and defaults the direct arm to that same model and reasoning setting. Set both `direct.model` and `direct.reasoning` in the specification to run a separate policy comparison, such as direct flagship use versus an Orqestra implementation policy. The report marks whether the models matched so those experiments cannot be confused.

Each repetition receives two detached worktrees at the exact source `HEAD`. Optional preparation commands run in both worktrees before timing and must leave Git-visible files clean. The arm order can alternate or remain fixed. Both arms receive the same bounded implementation prompt, attempt limit, timeout, acceptance criteria, and independent verification commands. Direct repair attempts use fresh `codex exec` turns because CLI resume support is not assumed; Orqestra retains its normal durable repair behavior. This difference remains explicit in the report.

Direct Codex runs with JSONL output, workspace-write sandboxing, disabled sandbox network access, and no approval grants. The runner retains token categories from `turn.completed`, hashes the event stream, and discards its content. Orqestra usage comes from App Server notifications. Raw agent messages, verifier output, task text, credentials, and backend logs are not written to the benchmark ledger or report.

Private artifacts remain under `.git/orqestra/benchmarks/<run-id>/`:

- `benchmark.json` is the strict paired ledger accepted by `orqestra benchmark`;
- `report.json` contains environment, policy and contract digests, arm order, worktree evidence, per-model coverage, and the evaluated totals;
- `worktrees/` retains both results for inspection;
- `state/` contains Orqestra durable-run checkpoints.

The source checkout must be clean before the run. Generated artifacts remain outside the working tree, but ignored files and external side effects still require the same care as other Orqestra execution. A cancelled or setup-failed benchmark can leave private worktrees for manual inspection; this alpha does not automatically delete evidence.

Automated runs treat the declared commands as verification and report their pass counts. They do not independently classify broader behavioral regressions, so their regression count remains zero. Use an imported ledger when a separate review process has classified regressions beyond the declared checks.

## Recorded paired benchmark

Start from [the benchmark template](../examples/benchmark.template.json) when importing observations collected elsewhere. Each trial contains one shared `taskId`, execution-contract SHA-256 digest, and Git base commit, followed by a direct Codex observation and an Orqestra observation. Repeat the same task from fresh worktrees at that exact commit and run the same independent verification commands for both arms.

An observation records:

- `source`: exactly `direct-codex` or `orqestra` for its arm;
- `observedAt` in UTC;
- `status`;
- passed and total verification checks;
- detected regressions;
- retries after the initial attempt;
- elapsed milliseconds;
- account mode, optional measured token categories, and optional measured API cost.

Leave an arm `null` when it was not executed. Then evaluate the completed record:

```sh
orqestra benchmark --input benchmark.json --json
```

The evaluator accepts legacy schema 1 ledgers and schema 2 ledgers with per-model rows. It rejects changed contract hashes or base commits for repeated trials of one task. It includes only pairs with both executed arms in completion, quality, retry, and time totals. Schema 2 token differences require complete per-model turn coverage in both arms. A negative difference means Orqestra used less within those executed pairs; it is not an extrapolated savings claim.

The file is an evidence ledger, not an attestation service. Orqestra validates its structure and shared conditions but cannot prove that caller-recorded measurements came from the declared run. Keep raw commands, prompts, environment details, verifier versions, and result artifacts outside the public ledger when they contain private data; publish enough non-sensitive method detail for another person to repeat the benchmark.
