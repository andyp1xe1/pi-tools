# Nix environment feedback

The extension detects missing commands in Bash output and sends Pi a hidden hint about project flakes and matching reusable shells.

It records failures in `<agent-dir>/extensions/pi-tools-missing-tools.json`. After five occurrences, the hint suggests adding the executable to your Nix configuration.

- `/cmdstats` lists the ten most frequently missing executables.
- `/cmdstats yt-dlp` shows one executable's history.
- `/cmdstats reset` clears the history.

The extension also records failures from user-entered Bash commands. It searches `~/dev/pi-agent-shells`, the directory used by the [dev shell manager](dev-shell-manager.md).
