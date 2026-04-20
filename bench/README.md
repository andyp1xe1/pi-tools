# Mini bench

Run date: 2026-04-20

This directory stores a small post-prompt-patch benchmark for `pi-nix-tools`.

## Scope

10 non-crazy tasks covering:

- host CLI detection
- missing CLI recovery via `ensure_dev_shell`
- shell reuse with `nix develop`
- Python package setup
- Bun behavior
- a small subtitle download task

## Key takeaways

- Clear passes: 5
- Clear failures: 2
- Mixed / partials: 3

### Clear passes

- `t03_node_version`
- `t04_npm_react`
- `t05_npm_vite`
- `t06_python_requests_title`
- `t10_rg_version`

### Clear failures

- `t01_ytdlp_version`
- `t02_ffmpeg_version`

These still treated “usable on this machine” as host-PATH-only, instead of considering existing or prepared flake shells.

### Mixed / partials

- `t07_bun_version`: correct result, but overcomplicated shell creation despite host Bun existing
- `t08_jq_extract`: correct answer, but ignored explicit tool-use request and used no tool
- `t09_download_subtitle`: tool execution succeeded on rerun, but shell reuse was weak and final assistant turn hit a provider-side `Forbidden`

## Saved files

- `summary.json`: normalized per-task summary
- `run.py`: bench runner script used for this batch
