# Contributing

Use Node.js 22 and npm. Keep pull requests focused on a milestone or a concrete defect. Describe the resulting behavior, validation, and remaining limitations.

Once the foundation is installed:

```sh
npm ci
npm run check
```

Tests must not need an account or start paid model turns. Live integration checks are separate and must identify the runtime version and operations performed. Add fixtures for failure paths and configuration compatibility when changing those contracts.

Do not include credentials, conversation exports, local run records, or third-party reference checkouts in contributions. Model presets are starting policies, not measured capability rankings.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), rather than a public issue.
