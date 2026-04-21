# pi-nix-tools

Small pi package for NixOS-oriented behavior.

## Current contents

- `skills/nixos-dev-shells/`: on-demand NixOS environment guidance for choosing between host tools, project flakes, and reusable shells.
- `extensions/nix-env-feedback.ts`: tracks only missing executable failures, sends a hidden steering hint after missing-command bash failures, and adds `/cmdstats [query]` for missing-tool stats.
- `extensions/dev-shell-manager.ts`: registers an `ensure_dev_shell` tool for creating minimal reusable flake dev shells from `cliPackages`, `pythonPackages`, and `bunPackages` inputs.

## Use

Global install:

```bash
pi install <home>/dev/pi-nix-tools
```

Project-local install:

```bash
pi install -l <home>/dev/pi-nix-tools
```

Or add the path to `packages` in `~/.pi/agent/settings.json` or `.pi/settings.json`.

## Notes

- Behavior is intentionally simple:
  - NixOS environment guidance now lives in the `nixos-dev-shells` skill instead of being injected into every chat
  - if a command fails because an executable is missing, pi sends a hidden steer hint telling the model to use an existing flake shell or `ensure_dev_shell`
- Shell location convention:
  - project tasks: use the project root `./flake.nix`
  - general reusable tasks: use `~/dev/pi-agent-shells/<name>/flake.nix`
- The `ensure_dev_shell` tool creates reusable shells at `~/dev/pi-agent-shells/<name>/flake.nix`.
- For project-specific work, pi should inspect and edit the project root `flake.nix` directly when needed.
- `ensure_dev_shell` inputs are capability-based:
  - `cliPackages`: nixpkgs package names like `yt-dlp`, `ffmpeg`, `jq`
  - `pythonPackages`: `python3Packages` names like `requests`, `beautifulsoup4`
  - `bunPackages`: bun dependency names written to a generated `package.json`
- Missing-tool stats are stored in `~/.pi/agent/extensions/pi-nix-tools-missing-tools.json`.
- `/cmdstats` reports only missing executables, not broad command telemetry.

```bash
/cmdstats
/cmdstats ytdlp
/cmdstats reset
```
