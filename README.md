<p align="center">
  <img src="logo.png" alt="pi-tools logo" width="200" />
</p>

# pi-tools

Small local pi package for Moss's pi extensions and skills.

## Contents

- `extensions/dev-shell-manager.ts`: registers `ensure_dev_shell` for creating reusable Nix flake dev shells.
- `extensions/nix-env-feedback.ts`: tracks missing executable failures and gives hidden Nix shell guidance after missing-command bash failures.
- `extensions/latex-renderer.ts`: registers `render_latex` and `/latex-renderer-test`.
- `extensions/pi-pkm.ts`: registers `/org-agenda` and `Alt+X` for the PKM agenda TUI.
- `skills/nixos-dev-shells/`: NixOS shell selection guidance.

## Use

Global install:

```bash
pi install <path-to-clone>
```

Or add the path to `packages` in `~/.pi/agent/settings.json` or `.pi/settings.json`.

In `~/nix-config`, this package should be listed as:

```nix
"<path-to-clone>"
```

## Development

```bash
npm run fix
npm run check
```

Smoke tests:

```bash
pi --no-session --no-tools --offline -e ./extensions/pi-pkm.ts -p /org-agenda
pi --no-session --no-tools --offline -e ./extensions/latex-renderer.ts -p /latex-renderer-test
```
