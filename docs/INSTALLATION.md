# Install the public alpha

Orqestra runs locally and installs its Codex skill inside each project. It does not replace Codex, sign in, change the selected conversation model, or modify Codex settings.

## Requirements

- Node.js 22 or newer and npm.
- Codex only for model discovery or live worker execution. The offline demo and policy preview need no Codex account or API key.
- A Git repository is required only for `run` and `coordinate`.

## Install a versioned release

Download `mobarakat313-orqestra-0.1.0-alpha.1.tgz` and `SHA256SUMS.txt` from the [v0.1.0-alpha.1 release](https://github.com/MoBarakat313/Orqestra/releases/tag/v0.1.0-alpha.1). Verify that the archive's SHA-256 value matches the checksum file, then install that exact archive:

```sh
npm install --global ./mobarakat313-orqestra-0.1.0-alpha.1.tgz
orqestra version
```

The GitHub archive is the supported alpha distribution. The package is not published to the npm registry in this milestone.

## Set up a project

Run one command from any terminal, including the terminal inside Codex:

```sh
orqestra setup --project /absolute/path/to/your-project --profile balanced
```

`setup` creates `orqestra.config.json` when absent and installs the self-contained skill at `.agents/skills/orqestra/`. It is safe to repeat. A current installation is left alone; a pristine older Orqestra installation is upgraded. Existing project instructions, Codex settings, and unrelated skills are preserved.

Open or reload the project in Codex and ask:

```text
$orqestra preview a plan for my task
```

Check the local prerequisites before live execution:

```sh
orqestra doctor
orqestra models
```

`doctor` may fail while the offline demo still works. It does not install or upgrade Codex.

## Upgrade

Download and install the newer versioned archive, then run either command:

```sh
orqestra setup --project /absolute/path/to/your-project
orqestra upgrade-skill --project /absolute/path/to/your-project
```

The upgrade verifies every manifest-owned file before staging a replacement. It refuses modified files, added artifacts, symlinks, and invalid ownership metadata. Preserve intentional local changes before upgrading.

Configuration schema 2 adds `limits.turnTimeoutSeconds`. `setup` migrates a schema 1 policy to schema 2 and keeps the original as `orqestra.config.json.v1.bak`. To migrate separately:

```sh
orqestra migrate-config --config /absolute/path/to/orqestra.config.json
```

Current policies are validated without being rewritten. Unknown schema versions are rejected.

## Remove

```sh
orqestra uninstall-skill --project /absolute/path/to/your-project
npm uninstall --global @mobarakat313/orqestra
```

Skill removal succeeds only when all owned artifacts still match their recorded hashes. The project policy, project instructions, Codex settings, and parent skill directories remain. Remove the policy or migration backup yourself only if you no longer need them.

## Install from source

```sh
git clone https://github.com/MoBarakat313/Orqestra.git
cd Orqestra
npm ci
npm run check
node dist/src/cli.js setup --project /absolute/path/to/your-project
```

Source installation is useful for development. Public alpha release archives are immutable versioned inputs and include a checksum.
