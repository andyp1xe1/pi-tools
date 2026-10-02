# Browser check

`browser-check` inspects pages through a persistent Playwright session. Commands return JSON.

```sh
browser-check open --profile preview --session check https://example.com
browser-check wait --session check 'main'
browser-check snapshot --session check
browser-check screenshot --session check
browser-check close --session check
```

Use `rect`, `styles`, and `eval` for measurements. Use `click`, `fill`, and `press` for interactions. `record --session check` starts an MP4 recording. `record --session check stop` saves it.

For manual sign-in, run `browser-check login --profile preview URL`. Sign in and close Chrome before using that profile for automation. Each profile permits one browser at a time.

Opening a page does not prove app readiness. Wait for an app-specific element and run each session's commands in sequence.

The CLI requires Node 22 and Google Chrome. Recording requires FFmpeg, which the Nix package includes. Captures can contain private data.

Run `browser-check help` for commands. See [the browser-check skill](../skills/browser-check/SKILL.md) for the full workflow.
