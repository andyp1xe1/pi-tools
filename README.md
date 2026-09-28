<p align="center">
  <img src="logo.png" alt="pi-tools logo" width="200" />
</p>

# pi-tools

[Pi](https://github.com/earendil-works/pi-coding-agent) extensions, skills, and a browser CLI.

<p align="center">
  <img src="docs/images/showcase.png" alt="LaTeX renderer and org agenda in pi" width="720" />
</p>

## What is included

| Name                  | Purpose                                                                | Details                                              |
| --------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `audio-transcription` | Registers `transcribe_audio` when Whisper is available.                | [Audio transcription](docs/audio-transcription.md)   |
| `dev-shell-manager`   | Creates reusable Nix dev shells.                                       | [Dev shell manager](docs/dev-shell-manager.md)       |
| `nix-env-feedback`    | Detects missing commands in bash output. Adds `/cmdstats`.             | [Nix environment feedback](docs/nix-env-feedback.md) |
| `latex-renderer`      | Renders block LaTeX as images in pi.                                   | [LaTeX renderer](docs/latex-renderer.md)             |
| `pi-pkm`              | Displays tasks from the builtin, todo.txt, and Emacs agenda providers. | [Pi PKM](docs/pi-pkm.md)                             |
| `telegram`            | Connects a Telegram chat to a pi session.                              | [Telegram bridge](docs/telegram.md)                  |
| `browser-check`       | Measures pages and interacts with Chrome through a local CLI.          | [Browser-check guide](docs/browser-check.md)       |

The `nixos-dev-shells`, `btca-local`, `linear-cli`, and [`browser-check`](skills/browser-check/SKILL.md) skills live in `skills/`.

## Install

Install this repository as a pi package:

```sh
pi install <path-to-clone>
```

Pi discovers the extensions and skills. For a source checkout, install dependencies and run the CLI:

```sh
npm ci
node bin/browser-check.mjs help
```

Pi installs the root Playwright dependency when it installs pi-tools from git. See the [browser-check guide](docs/browser-check.md) for Chrome requirements and the command to put the CLI on `PATH`.

### Home Manager

The flake exports an optional Home Manager module:

```nix
imports = [ inputs.pi-tools.homeManagerModules.default ];

programs.pi-tools = {
  enable = true;
  piCliPackage = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.pi;
  telegram.enable = true;
  audioTranscription.enable = true;
};
```

With `programs.pi-tools.enable = true`, the module adds the Nix-built `browser-check` executable to `PATH` through `home.packages`. Set `programs.pi-tools.browserCheck.enable = false;` to omit the CLI, its skill, and Playwright from the default Nix package. Set `programs.pi-tools.browserCheck.package` to use a different CLI build. The module also writes pi settings and installs `piCliPackage` if supplied. The `telegram` and `audioTranscription` options are off unless enabled.

The default pi theme is `gruvbox-dark`. The module also recommends `pi-web-access`. Set `theme = null;` or `recommendedPackages = [];` to omit either default. Use `extraPackages` and `settings` for other pi settings.

## Develop

```sh
npm install
npm run check
npm run fix
npm run test:browser-check
```

Run either extension without a session or network access:

```sh
pi --no-session --no-tools --offline -e ./extensions/pi-pkm.ts -p /org-agenda
pi --no-session --no-tools --offline -e ./extensions/latex-renderer.ts -p /latex-renderer-test
```

## Attribution and license

- [Telegram bridge attribution](src/telegram/NOTICE.md)
- [`btca-local` source](https://github.com/davis7dotsh/better-context/blob/main/skills/btca-local/SKILL.md)
- [GPL-3.0 license](LICENSE)
