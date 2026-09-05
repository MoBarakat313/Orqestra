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

## Reproducible paired benchmark

Start from [the benchmark template](../examples/benchmark.template.json). Each trial contains one shared `taskId`, execution-contract SHA-256 digest, and Git base commit, followed by a direct Codex observation and an Orqestra observation. Repeat the same task from fresh worktrees at that exact commit and run the same independent verification commands for both arms.

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

The evaluator rejects changed contract hashes or base commits for repeated trials of one task. It includes only pairs with both executed arms in completion, quality, retry, and time totals. Token and API-cost differences have their own stricter paired counts and appear only when both arms contain the corresponding measured value. A negative difference means Orqestra used less within those executed pairs; it is not an extrapolated savings claim.

The file is an evidence ledger, not an attestation service. Orqestra validates its structure and shared conditions but cannot prove that caller-recorded measurements came from the declared run. Keep raw commands, prompts, environment details, verifier versions, and result artifacts outside the public ledger when they contain private data; publish enough non-sensitive method detail for another person to repeat the benchmark.
