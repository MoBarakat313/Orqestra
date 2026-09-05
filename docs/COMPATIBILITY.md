# Compatibility evidence

Verified on 2026-09-05. This is a bounded record, not a guarantee for every account or installation.

| Surface | Version / environment | Result |
| --- | --- | --- |
| Offline foundation and packaging | Node.js 22; GitHub Linux, macOS, Windows runners | M1 checks passed on all three platforms at commit `407565e`. |
| Existing local Codex executable | `codex-cli 0.20.0` | Correctly rejected by preflight: no App Server command advertised. |
| Isolated official npm Codex package | `@openai/codex@0.153.4`, macOS ARM64, Node.js 22.22.3 | Handshake, account-mode read, and model discovery succeeded. Global CLI unchanged. |
| Project-local skill discovery | Codex CLI 0.153.4 `skills/list` against a temporary project | Orqestra found and enabled under `.agents/skills/orqestra/SKILL.md`. No model turn. |
| Installed skill helper | Copied runtime, independent temporary project | Offline demo and installation into a second project succeeded without a global npm package. |
| One-worker execution | `@openai/codex@0.153.4`, GPT-5.6 Terra/medium, disposable clean Git repository | One ephemeral turn created the requested file; two independent tests passed; Git history stayed unchanged; no approval was requested. |

The live account-mode result was ChatGPT. The runtime listed Astra, Sol, Terra, Luna, GPT-5.5, and GPT-5.4 Mini. Only the standard preset families are currently bound by default. Model listing is not proof that a subsequent turn will be authorized, and account access can change.

The observed reasoning options were `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` for Astra/Sol/Terra; Luna stopped at `max`. This illustrates why actual runtime discovery must supplement API documentation. Existing user configuration is never silently rewritten to match a newly observed catalog.

The first sandboxed discovery attempt exited before completing initialization; the same read-only command succeeded with the local filesystem/network permissions required by Codex. Orqestra does not change those permissions automatically. Account emails, tokens, full logs, and raw account responses were not persisted in this repository.

Source references: [App Server](https://learn.chatgpt.com/docs/app-server), [project skill discovery](https://learn.chatgpt.com/docs/build-skills).

Not yet verified against a real installation: interactive approval UI, cancellation of a live model turn, usage accounting, Windows native/shim discovery, or automatic upgrades. Offline subprocess fixtures cover scoped approval forwarding with fail-closed cancellation, `turn/interrupt`, worker/process failures, and failed independent verification. One tiny successful task does not establish broad model quality or savings.
