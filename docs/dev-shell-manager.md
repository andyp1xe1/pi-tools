# Dev shell manager

`ensure_dev_shell` creates a reusable Nix flake under `~/dev/pi-agent-shells/<name>/`.

```json
{
	"name": "yt-tools",
	"cliPackages": ["yt-dlp", "ffmpeg"],
	"pythonPackages": ["requests"]
}
```

Use nixpkgs attribute names for `cliPackages` and `pythonPackages`. Use Bun dependency names for `bunPackages`.

```sh
nix develop ~/dev/pi-agent-shells/yt-tools -c yt-dlp --version
```

Reusing a name overwrites its flake. For project-specific dependencies, edit the project's flake instead.

[Nix environment feedback](nix-env-feedback.md) finds matching shells when a command is missing.
