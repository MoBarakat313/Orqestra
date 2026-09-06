# Quick installation with Codex

Use this path when you want Codex Desktop to install Orqestra for the currently open project. Use the [manual installation guide](INSTALLATION.md) when you prefer to inspect and run every command yourself.

## Copy one prompt

Open the target project in Codex Desktop and paste:

```text
Install Orqestra in the project currently open in Codex from the latest release at https://github.com/MoBarakat313/Orqestra/releases.

First check that Node.js 22 or newer and npm are available. If either is missing, stop and explain what I need to install; do not install or upgrade Node.js, npm, or Codex automatically.

Download only the versioned mobarakat313-orqestra-<version>.tgz release asset and SHA256SUMS.txt into a temporary directory. Do not use GitHub's Source code archive. Verify the archive against SHA256SUMS.txt and stop if verification fails.

Install the verified archive globally with npm without sudo. Then run Orqestra setup for the currently open project using the Balanced profile. Verify the installation with skill-status and run doctor. Report a doctor compatibility failure separately; it does not mean that project installation failed.

Preserve all existing project instructions, skills, Codex settings, configuration, and user files. Remove the temporary download files when finished. Report the installed version, files added to the project, doctor result, and whether Codex needs to be reloaded.
```

The prompt authorizes only the verified Orqestra package installation and setup of the open project. It does not authorize installation or upgrades of Node.js, npm, Codex, or unrelated software.

## Expected result

A successful first installation has:

```text
<project>/
├── orqestra.config.json
└── .agents/
    └── skills/
        └── orqestra/
            ├── SKILL.md
            ├── LICENSE
            ├── manifest.json
            └── scripts/
```

The globally installed `orqestra` command manages installation and diagnostics. The project skill contains its own helper, so Codex can use it from that project without relying on the global command for each task.

`skill-status` should report a current, unchanged installation. `doctor` checks whether a compatible Codex CLI is available for model discovery and live workers. A doctor failure does not undo a successful project installation; the offline demo and route calculation remain available.

Open or reload the project after setup. If the skill does not appear in Codex, restart Codex once, confirm that the same project path is open, and follow the [troubleshooting steps](INSTALLATION.md#troubleshooting).

**Next: [learn the important commands](BEGINNER_COMMANDS.md).**
