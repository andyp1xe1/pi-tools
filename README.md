<p align="center">
  <img src="logo.png" alt="pi-tools logo" width="200" />
</p>

# pi-tools

A small package of [pi](https://github.com/earendil-works/pi-coding-agent) extensions and skills, mostly aimed at making pi feel more at home on a NixOS box and pushing toward a richer, org-mode-flavored document experience inside the TUI.

The project is intentionally experimental — see [`docs/GOAL.md`](docs/GOAL.md) for the broader direction.

<p align="center">
  <img src="docs/images/showcase.png" alt="LaTeX renderer and org-agenda inside pi's TUI" width="720" />
  <br />
  <em>Tail of <code>/latex-renderer-test</code> with the <code>/org-agenda</code> pane focused below.</em>
</p>

## Extensions

| Extension           | What it does                                                                                                                                                                                                         | Docs                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `dev-shell-manager` | Creates reusable Nix flake dev shells on demand under `~/dev/pi-agent-shells/<name>`.                                                                                                                                | [docs/dev-shell-manager.md](docs/dev-shell-manager.md) |
| `nix-env-feedback`  | Watches bash failures for missing commands and steers the model toward an existing reusable shell. Adds `/cmdstats`.                                                                                                 | [docs/nix-env-feedback.md](docs/nix-env-feedback.md)   |
| `latex-renderer`    | `render_latex` tool that displays Markdown with block LaTeX rendered as inline PNGs. Adds `/latex-renderer-test`.                                                                                                    | [docs/latex-renderer.md](docs/latex-renderer.md)       |
| `pi-pkm`            | Org-style agenda pane in the TUI with pluggable providers (`todo.txt` + emacs), project-local persistence, refresh, and DONE write-back. Adds `/org-agenda`, `/org-agenda-refresh`, `/org-agenda-done`, and `Alt+X`. | [docs/pi-pkm.md](docs/pi-pkm.md)                       |

## Skills

- `skills/nixos-dev-shells/` — selection rules for host vs. project flake vs. reusable shell. Paired with the two nix extensions above.
- `skills/btca-local/` — local git repo search workflow for "use btca" prompts.

## Install

Clone the repo, then install it globally as a pi package:

```bash
pi install <path-to-clone>
```

Or add the clone path to the `packages` array in `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (per-project).

### Home Manager module

The flake also exports an opt-in Home Manager module:

```nix
imports = [
  inputs.pi-tools.homeManagerModules.default
];

programs.pi-tools = {
  enable = true;
  piCliPackage = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.pi;
};
```

The module writes `~/.pi/agent/settings.json`, installs `piCliPackage` when provided, and adds the Nix-built `pi-tools` package to pi's package list.

By default this is an opinionated pi-tools distro config: theme `gruvbox-dark`, bundled pi-tools extensions/skills/themes, and `npm:pi-web-access`. Override with `theme = null;`, `recommendedPackages = [];`, `extraPackages = [...]`, and raw `settings = {...};` as needed.

## Develop

```bash
npm install
npm run fix     # biome format + lint --write
npm run check   # biome check
```

Smoke tests (run each extension in isolation, no session, no tools, no network):

```bash
pi --no-session --no-tools --offline -e ./extensions/pi-pkm.ts -p /org-agenda
pi --no-session --no-tools --offline -e ./extensions/latex-renderer.ts -p /latex-renderer-test
```

## References

- `skills/btca-local/` is vendored from [`davis7dotsh/better-context`](https://github.com/davis7dotsh/better-context), source skill: [`skills/btca-local/SKILL.md`](https://raw.githubusercontent.com/davis7dotsh/better-context/refs/heads/main/skills/btca-local/SKILL.md).

## License

GPL-3.0 — see [LICENSE](LICENSE).
