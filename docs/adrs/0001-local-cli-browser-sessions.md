# 0001: Local CLI sessions and manual-login profiles

Status: Proposed

## Context

Screenshots cannot answer every layout question. A coding agent needs page measurements and a way to reuse a profile after a person signs in. The agent must not handle credentials or login challenges.

## Decision

Provide a Node and Playwright CLI with JSON output. Each named session runs a detached worker over a private Unix socket. Keep Chrome profiles outside the repository and give each profile one owner at a time. Login starts ordinary visible Chrome without Playwright or remote debugging. The person signs in; automation later opens the same profile.

The CLI supports page evaluation, rectangles, styles, accessible snapshots, browser input, screenshots, and traces. Evaluation runs trusted code in the page; it is not read-only. The calling agent supplies the expected values. The CLI leaves the site's CSS and animations unchanged.

Run one command at a time per session. Limit request and result sizes. Close a session after a browser command timeout so a delayed action cannot run after the caller sees a failure. If ownership or crash cleanup is uncertain, leave the profile locked for inspection. Never kill an unrelated browser or erase a profile automatically.

Keep the CLI in `bin/browser-check.mjs` and its implementation in `src/browser-check/`. Expose its workflow through `skills/browser-check/`. The default pi-tools Nix package includes Playwright. When `programs.pi-tools.browserCheck.enable` is false, the Home Manager module selects a package without the CLI, skill, or Playwright dependency. Otherwise, it installs the Nix-built CLI on `PATH`. The CLI does not depend on the Pi SDK.

## Consequences

- No model credentials, central daemon, or browser-control TCP port.
- Profiles and captures can contain private data and need private storage.
- Manual login needs a graphical desktop on the host.
- Automation controls one tab. Frame-specific controls and remote login are not supported.
- A crashed worker may leave a profile lease that needs manual inspection. Names do not restrict a profile to one site.
- App-specific assertions belong in the app's tests.

## Links

- [Usage and recovery guide](../browser-check.md)
- [Workflow skill](../../skills/browser-check/SKILL.md)
- [pi-tools installation](../../README.md)
