# Browser CLI

`browser-cli` inspects pages through a persistent Playwright session. Commands return JSON.

```sh
browser-cli open --profile preview --session check https://example.com
browser-cli wait --session check 'main'
browser-cli snapshot --session check
browser-cli screenshot --session check
browser-cli close --session check
```

Use `rect`, `styles`, and `eval` to measure the page. Use `click`, `fill`, and `press` to interact with it. `record --session check` starts an MP4 recording. `record --session check stop` saves it.

For manual sign-in, run `browser-cli login --profile preview URL`. Sign in and close Chrome before using that profile for automation. Each profile permits one browser at a time.

Opening a page does not prove the app is ready. Wait for an app-specific element and run each session's commands in sequence.

The CLI requires Node 22 and Google Chrome. Recording requires FFmpeg, which the Nix package includes. Captures can contain private data.

Run `browser-cli help` for commands. See [the browser-cli skill](../skills/browser-cli/SKILL.md) for the full workflow.

## Rename and data compatibility

The executable, npm bin, skill, and Nix package are now `browser-cli`. The npm test script is `test:browser-cli`. Nix also exports `without-browser-cli`.

Home Manager uses `programs.pi-tools.browserCli`. The old `browserCheck` option still works and warns to use `browserCli`. The package does not provide aliases for the old executable or Nix package names.

### Data directories and environment variables

The default data directory is `$XDG_DATA_HOME/browser-cli` or `~/.local/share/browser-cli`. The CLI does not move, copy, or delete existing data during the rename.

`BROWSER_CLI_HOME` selects the directory for profiles and artifacts. The deprecated `BROWSER_CHECK_HOME` works as a fallback when `BROWSER_CLI_HOME` is unset or empty. If both have nonempty values, `BROWSER_CLI_HOME` wins.

To reuse data that still lives in the old directory, set `BROWSER_CLI_HOME="$HOME/.local/share/browser-check"` for both login and automation. If you have moved the data to the new default directory, remove any override that points to the old one.

`BROWSER_CLI_REVISION` overrides the revision reported by `version`. The deprecated `BROWSER_CHECK_REVISION` works as a fallback when `BROWSER_CLI_REVISION` is unset or empty.

### Sessions and profile locks

The new binary stores runtime session records under `browser-cli`. It cannot list or control the old binary's sessions. Close those sessions with the old binary and the same data-home override before switching versions or moving data. Do not move a profile while either version owns it.

Both versions use `profiles/NAME/lease` and Chromium's own profile lock. If they use the same data directory, they cannot own the same profile at once. The CLI leaves stale leases for inspection. Do not remove locks or stop unrelated Chrome processes.

A copy in another data directory is a separate profile. It does not share the original profile's lease.

### Activate the renamed CLI

For Nix, update the consuming flake lock and activate the new Home Manager generation. Updating the lock alone does not change `PATH`. For a source checkout, rerun `npm link`.

Update any explicit skill-path filters and reload Pi to discover `browser-cli`. Move data only after all sessions that use it have closed. Neither the CLI nor the Home Manager module migrates it.
