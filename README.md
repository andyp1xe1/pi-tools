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

Clone the repo, then install it globally:

```bash
pi install <path-to-clone>
```

Or add the clone path to `packages` in `~/.pi/agent/settings.json` or `.pi/settings.json`.

If you manage pi via a Nix config, list the clone path under the package's `packages` entry.

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
