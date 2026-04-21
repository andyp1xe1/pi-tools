---
name: nixos-dev-shells
description: NixOS shell and tool selection guidance. Use when a task depends on a CLI, runtime, or library that may not be installed, when a command is missing, or when deciding whether to use the host PATH, a project flake, or a reusable shell under ~/dev/pi-agent-shells.
---

# NixOS Dev Shells

Use this skill when environment setup matters.

## Core rules

- This machine is NixOS.
- Do not assume tools, runtimes, or libraries are globally installed.
- Do not treat the presence of Python or Bun as proof that the needed packages are available.
- Do not suggest apt, yum, brew, or global pip installs.
- If a known dedicated CLI fits the task, prefer that CLI over ad-hoc scripting.
- If the requested CLI already works directly on the host and the task is a simple one-off command, use it directly.

## Shell selection order

1. For project work, inspect `./flake.nix` first.
2. If a project shell exists, prefer `devShells.<system>.pi`, then `devShells.default`.
3. For general reusable tasks, reuse an existing shell under `~/dev/pi-agent-shells/<name>` when one fits.
4. Only create a new reusable shell when no suitable existing shell is available.

## Preferred execution pattern

For one-off commands, prefer:

```bash
nix develop <target> -c <command>
```

## Reusable shells

When a reusable shell is needed, use the `ensure_dev_shell` tool.

- `cliPackages`: nixpkgs package attribute names like `jq`, `yt-dlp`, `ffmpeg`
- `pythonPackages`: `python3Packages` attribute names like `requests`, `beautifulsoup4`
- `bunPackages`: Bun dependency names like `hono`, `zod`

Use `ensure_dev_shell` only for reusable shells under `~/dev/pi-agent-shells/<name>`.
For project-specific work, prefer editing the project `flake.nix` instead.

## Missing command recovery

If a command is missing:

1. Check whether the project flake already provides it.
2. Otherwise check for a suitable reusable shell in `~/dev/pi-agent-shells`.
3. Otherwise create a minimal reusable shell with `ensure_dev_shell`.
4. Retry the command inside that shell.

## Scripting

Use scripting only after ruling out a suitable dedicated CLI, or when scripting is clearly the better tool.
If scripting is needed, first ensure the runtime and packages are available through a flake shell.
