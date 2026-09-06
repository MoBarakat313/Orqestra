# Install the public alpha

Orqestra runs locally and installs its Codex skill inside each project. It does not replace Codex, sign in, change the selected conversation model, or modify Codex settings.

Want Codex to perform the verified setup? Use the [one-prompt quick installation](QUICK_INSTALL.md). Continue below when you prefer to run each installation command yourself.

## Requirements

- Node.js 22 or newer and npm.
- Codex only for model discovery or live worker execution. The offline demo and policy preview need no Codex account or API key.
- A Git repository is required only for `run` and `coordinate`.

## Install a versioned release

Download `mobarakat313-orqestra-0.1.0-alpha.2.tgz` and `SHA256SUMS.txt` from the [v0.1.0-alpha.2 release](https://github.com/MoBarakat313/Orqestra/releases/tag/v0.1.0-alpha.2). Verify that the archive's SHA-256 value matches the checksum file, then install that exact archive:

### macOS

```sh
shasum -a 256 -c SHA256SUMS.txt
npm install --global ./mobarakat313-orqestra-0.1.0-alpha.2.tgz
orqestra version
```

### Linux

```sh
sha256sum -c SHA256SUMS.txt
npm install --global ./mobarakat313-orqestra-0.1.0-alpha.2.tgz
orqestra version
```

### Windows PowerShell

```powershell
$archive = ".\mobarakat313-orqestra-0.1.0-alpha.2.tgz"
$expected = (Get-Content .\SHA256SUMS.txt).Split()[0].ToLower()
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA-256 checksum does not match" }
npm install --global $archive
orqestra version
```

Do not continue after a checksum mismatch. Download both release files again and verify that they came from the release page above.

The GitHub archive is the supported alpha distribution. The package is not published to the npm registry in this milestone.

## Set up a project

Run one command from any terminal, including the terminal inside Codex:

```sh
orqestra setup --project /absolute/path/to/your-project --profile balanced
```

`setup` creates `orqestra.config.json` when absent and installs the self-contained skill at `.agents/skills/orqestra/`. It is safe to repeat. A current installation is left alone; a pristine older Orqestra installation is upgraded. Existing project instructions, Codex settings, and unrelated skills are preserved.

Run setup separately for every project where Orqestra should be available. Then open or reload that project in Codex Desktop. Orqestra should appear in the Skills section of the sidebar. If it does not, reload or restart Codex and check the installation:

```sh
orqestra skill-status --project /absolute/path/to/your-project
orqestra doctor
```

Start a Codex prompt with `$orqestra`:

```text
$orqestra preview a plan for adding CSV export to this project, including tests.
```

Preview explains the proposed route, model assignments, verification depth, and assumptions without implementing the task. To proceed, use a separate implementation prompt:

```text
$orqestra implement the CSV export using the Balanced profile and verify the result.
```

Additional examples:

```text
$orqestra show which Codex models are available for this project and validate the policy.

$orqestra resume run <run-id> using the same task contract.

$orqestra coordinate these independent packages: update the API in packages/api and the client in packages/client, then run the repository checks.
```

Codex inspects the repository and authors the explicit JSON assessment or execution contract required by the helper. Orqestra does not independently convert arbitrary natural language into a contract. Small direct work remains in the current Codex conversation; live worker or coordination execution proceeds only when the route and contract meet the documented boundaries.

Check the local prerequisites before live execution:

```sh
orqestra doctor
orqestra models
```

`doctor` may fail while the offline demo still works. It does not install or upgrade Codex.

Live `run` and `coordinate` commands require a compatible Codex CLI with App Server access through the user's existing account. Codex Desktop being installed does not guarantee that the CLI is available on `PATH`; use `--codex /path/to/codex` when needed. Setup, demo, and offline planning do not require live model access.

## Troubleshooting

If the shell reports `orqestra: command not found` after installation, close and reopen the terminal, then run:

```sh
npm prefix --global
```

Make sure npm's global executable directory is on `PATH`. Avoid installing with `sudo`; use the official Node.js installer or a Node version manager if npm reports global-directory permission errors.

If the skill does not appear in Codex Desktop, confirm that Codex opened the same absolute project path passed to `setup`, run `skill-status`, and reload or restart Codex. The skill must be at `<project>/.agents/skills/orqestra/SKILL.md`.

If `doctor` reports an old, missing, or incompatible Codex CLI, offline commands remain usable. Orqestra does not install, upgrade, or sign in to Codex. After making a compatible executable available, select it explicitly when necessary:

```sh
orqestra doctor --codex /absolute/path/to/codex
orqestra models --codex /absolute/path/to/codex
```

For command syntax, run `orqestra --help`. For tested versions and known runtime limits, read [COMPATIBILITY.md](COMPATIBILITY.md).

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

**Next: [learn the important Orqestra commands](BEGINNER_COMMANDS.md).**
