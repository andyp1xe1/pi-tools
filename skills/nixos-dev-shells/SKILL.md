---
name: nixos-dev-shells
description: NixOS shell selection guidance. Use when a task depends on tools or packages that may not be available on the host, when a command is missing, or when choosing between the host, a project flake, and a reusable shell under ~/dev/pi-agent-shells.
---

# NixOS Dev Shells

Use this skill when a task depends on tools or packages that may not be available on the host.

## Rules

- This machine is NixOS.
- Do not assume tools, runtimes, or libraries are globally installed.
- Prefer a dedicated CLI over scripting when one fits.
- Use scripting only when a suitable CLI does not fit the task.
- If the needed CLI already works on the host and the task is simple, use it directly.

## Shell order

1. For project work, inspect `./flake.nix` first.
2. Prefer `devShells.<system>.pi`, then `devShells.default`.
3. Otherwise reuse a fitting shell under `~/dev/pi-agent-shells/<name>`.
4. Only create a new reusable shell if none fits.

For one-off commands, prefer:

```bash
nix develop <target> -c <command>
```

If a command is missing, follow the shell order above and retry inside the chosen shell.

## Reusable shells

Use `ensure_dev_shell` only for reusable shells under `~/dev/pi-agent-shells/<name>`.
For project-specific work, prefer editing the project `flake.nix`.

- `cliPackages`: nixpkgs package names
- `pythonPackages`: `python3Packages` names
- `bunPackages`: Bun package names

