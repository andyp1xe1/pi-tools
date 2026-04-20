# Mini bench

Run date: 2026-04-20

This directory stores a small post-prompt-patch benchmark for `pi-nix-tools`.
It currently reflects the latest rerun after tightening the NixOS wording again.

## Scope

10 non-crazy tasks covering:

- host CLI detection
- missing CLI recovery via `ensure_dev_shell`
- shell reuse with `nix develop`
- Python package setup
- Bun behavior
- a small subtitle download task

## Key takeaways

Latest rerun outcome:

- Strong improvements on `yt-dlp` and `ffmpeg` discovery
- `jq` tool-use behavior improved
- `yt-dlp` subtitle task now completed cleanly
- Remaining noise is mostly provider-side `Forbidden` failures on some runs, not obviously policy-related

### Improved tasks

- `t01_ytdlp_version`: now reused `~/dev/pi-agent-shells/yt-dlp` via `nix develop`
- `t02_ffmpeg_version`: now found and used `~/dev/pi-agent-shells/video-download`
- `t08_jq_extract`: now actually used `jq`
- `t09_download_subtitle`: now returned the saved subtitle path successfully

### Remaining issues

- `t04_npm_react`: provider-side `Forbidden` after recovering from missing `npm`
- `t07_bun_version`: immediate provider-side `Forbidden`
- Shell selection is better, but still not perfectly semantic in every case

## Saved files

- `summary.json`: normalized per-task summary
- `run.py`: bench runner script used for this batch
