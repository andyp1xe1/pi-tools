# pi dev-shell-manager

Lets pi spin up reusable Nix flake dev shells on demand, so a missing CLI, Python lib, or Bun runtime isn't a blocker.

It registers an `ensure_dev_shell` tool. The model calls it with a name plus any of `cliPackages`, `pythonPackages`, or `bunPackages`, and a self-contained flake is materialized at `~/dev/pi-agent-shells/<name>/`.

## What it generates

For a call like:

```json
{
  "name": "yt-tools",
  "cliPackages": ["yt-dlp", "ffmpeg"],
  "pythonPackages": ["requests"]
}
```

three files appear under `~/dev/pi-agent-shells/yt-tools/`:

- `flake.nix` — pinned to `nixpkgs/nixos-unstable`, with `cliPackages` mapped to top-level attrs, `pythonPackages` wrapped in `python3.withPackages`, and `bun` added if `bunPackages` is requested.
- `package.json` — only written when `bunPackages` is non-empty; lists each bun dependency with `"latest"`.
- `README.md` — quickstart with the `nix develop <path> -c <command>` invocation.

Names are normalized to `[a-z0-9._-]+` (and lowercased); anything else collapses to `-`. Reusing the same name overwrites the existing flake.

## Usage from pi

The tool is invoked automatically by the model when it sees a missing runtime; you don't usually call it by hand. To use a generated shell ad hoc:

```bash
nix develop ~/dev/pi-agent-shells/yt-tools -c yt-dlp --version
```

## Guidelines the model follows

From the tool's `promptGuidelines`:

- Use before scripting against a runtime that may not be installed.
- Only for **reusable** shells under `~/dev/pi-agent-shells/<name>`; project-specific work edits the project's own flake instead.
- Pass nixpkgs attribute names, not pip/npm names: `python3Packages.requests` → `"requests"` in `pythonPackages`.

## Pairs with

- [`nix-env-feedback`](./nix-env-feedback.md) — detects missing commands at runtime and steers the model toward an existing reusable shell before suggesting a new one.
- `skills/nixos-dev-shells/` — selection rules for host vs. project flake vs. reusable shell.

## Source

- `extensions/dev-shell-manager.ts`
