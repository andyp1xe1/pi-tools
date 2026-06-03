# pi nix-env-feedback

Watches bash failures for `command not found` and feeds the model a hidden steering hint pointing at the right Nix shell, instead of letting it guess.

## What it does

On every `Bash` tool result, the extension:

1. Parses the output for `command not found` / `exec: <cmd>: not found` and an exit code of `127`.
2. Records the missing executable, the failing command, source (`bash-tool` or `user-bash`), and a running count in `<agent-dir>/extensions/pi-tools-missing-tools.json`.
3. Fuzzy-matches the executable name against reusable shells under `~/dev/pi-agent-shells/*` (first by shell name, then by `flake.nix` contents).
4. Sends a hidden steer message back to the model summarizing: whether a project `flake.nix` exists, which reusable shells look like a match, and (after 5+ sightings) a suggestion to add the tool to the user's Nix config.

The hint goes through `pi.sendMessage(..., { deliverAs: "steer" })` with `display: false`, so the user never sees it — only the model does.

Hint format:

```
Nix env hint: yt-dlp is missing here. Project flake: no. Matching reusable shells: yt-tools, media-fetch. Try the project flake first, then a fitting reusable shell.
```

The same parsing also runs on `user_bash` commands (commands the user typed themselves), so manually-run missing-command failures still get recorded.

## `/cmdstats`

A small command for inspecting or resetting the stats file.

```text
/cmdstats           # top 10 most-frequently-missing executables
/cmdstats yt-dlp    # detail for a single executable
/cmdstats reset     # wipe the stats file
```

Output is shown via `ctx.ui.notify` — it goes to the user, not the model.

## Config

- Stats file: `<agent-dir>/extensions/pi-tools-missing-tools.json`
- Reusable shells dir: `~/dev/pi-agent-shells` (matches the layout produced by [`dev-shell-manager`](./dev-shell-manager.md))
- "Nag for Nix config" threshold: 5 occurrences

These are constants in the source; tweak them in `extensions/nix-env-feedback.ts` if needed.

## Pairs with

- [`dev-shell-manager`](./dev-shell-manager.md) — provides the reusable shells this extension steers toward.
- `skills/nixos-dev-shells/` — selection rules the model leans on after receiving a hint.

## Source

- `extensions/nix-env-feedback.ts`
