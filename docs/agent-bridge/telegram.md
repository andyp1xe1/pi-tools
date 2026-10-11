# Run the Telegram daemon

The daemon owns the bot and automatically hosts native saved Pi SDK sessions. Sessions use a private local socket; they do not hold its token or poll Telegram. Independent conversations and each session's tool calls run in parallel.

## Configure a bot directly

The daemon automatically loads `$XDG_CONFIG_HOME/agent-bridge/env`, defaulting to `~/.config/agent-bridge/env`. Explicit environment variables take precedence.

```sh
mkdir -p ~/.config/agent-bridge
install -m 600 docs/agent-bridge/env.example ~/.config/agent-bridge/env
```

Set `TELEGRAM_BOT_TOKEN` and `AGENT_BRIDGE_OWNER_IDS` in that file. Keep credentials outside shared checkouts. The configuration must be owned by you and private.

Without owners, the bot reports your ID in a DM or `/where` in a group/topic. Set the reported ID and restart before routing project input or registering terminal sessions. No stranger can pair themselves by sending the first message.

Stop any older Pi Telegram poller before starting this daemon; cross-version lock compatibility is not provided.

Start the daemon with `agent-bridge start`, or `bun --no-env-file bin/agent-bridge.mjs start` from a source checkout. Keep foreground runs in a visible terminal pane, or enable the optional user service below.

A configured webhook causes startup to fail. The daemon does not delete it.

## Home Manager user service (Linux)

Installation and unattended operation are separate options:

```nix
programs.pi-tools = {
  enable = true;
  agentBridge = {
    enable = true;
    service.enable = true;
    # service.environmentFile = "/absolute/private/bridge.env";
    # service.extraPackages = [ pkgs.python3 ];
  };
  bot.enable = true; # Terminal saved-thread registration and communication tools
  audioTranscription.enable = true; # Optional Whisper in the service PATH
};
```

`agentBridge.enable` alone only installs the CLI. The service is off by default; enabling it also defaults CLI installation to on. Create the private environment file before starting it. Only its path enters the Nix store, not its contents. The service uses your home directory, local/profile/system executables, Home Manager's `home.sessionPath`, and basic coding tools; `service.extraPackages` adds project-independent tools. FFmpeg is provided by the CLI wrapper. It does not run `nix develop` or create per-project shells.

```sh
systemctl --user status agent-bridge
systemctl --user restart agent-bridge
systemctl --user stop agent-bridge
journalctl --user -u agent-bridge -f
```

The service starts with `default.target` and restarts failures after ten seconds, limited to five starts within five minutes. After correcting repeated startup failures, run `systemctl --user reset-failed agent-bridge` before starting it. Logs go to journald. Graceful shutdown has a 120-second deadline; unfinished input is not replayed. Terminal Herdr/Pi session identity and stale bridge/trial configuration are removed from the user-manager environment before launch. The daemon then loads its token, owners, database/socket overrides and bridge Whisper settings from the selected private file; command-line invocations still retain their usual explicit-environment precedence.

For operation after logout and at boot, deliberately enable lingering with `loginctl enable-linger "$USER"`. Managed agents then retain your account's filesystem and tool access even without a logged-in terminal. The service is not a sandbox and should never run as root.

### Declarative updates and rollback

Pin `pi-tools` to a Git source in your Nix configuration and commit its lock file. Deploy committed code, not a mutable local checkout. For a NixOS host with integrated Home Manager:

```sh
nix flake update pi-tools --flake /path/to/nix-config
nix build /path/to/nix-config#nixosConfigurations.HOST.config.system.build.toplevel
sudo nixos-rebuild switch --flake /path/to/nix-config#HOST
```

Review and commit the configuration changes before switching. Home Manager should be the sole owner of the generated Pi settings, service unit and enablement link. Its `systemd.user.startServices = "sd-switch"` handling reloads systemd and restarts changed units; no custom `ExecStart` drop-in or mutable runtime-package symlink is needed. Routine deployments update the pinned input and switch the normal generation.

For initial adoption of manually installed direct Nix-store symlinks, privately preserve the links first, then explicitly declare `force = true` on only the three generated files: `home.file.".pi/agent/settings.json"`, `xdg.configFile."systemd/user/agent-bridge.service"`, and `xdg.configFile."systemd/user/default.target.wants/agent-bridge.service"`. A backup extension alone does not adopt foreign symlinks. Never force or move the private environment file, database or saved sessions. Remove conflicting service drop-ins deliberately; do not overwrite unrelated files.

After switching, check `systemctl --user status agent-bridge`, `agent-bridge status`, the running package path and the journal. Roll back through the normal NixOS/Home Manager generation machinery if necessary; rolling back an executable does not require rolling back the database. Keep the private environment, SQLite state and native session history outside the package. Failed or interrupted turns are not automatically replayed.

If the deployment is requested through the bridge itself, run the standard switch from an independent terminal, CI or an external deploy unit. Restarting the bridge terminates its hosted agents; it must not own the process performing the deployment.

### Switching an existing foreground daemon

1. Finish current work; build the new package and Home Manager generation without activating it. Save the previous generation/package paths for rollback.
2. From a terminal that survives the daemon, run `agent-bridge stop`; wait for its process to exit and release the socket/poller lock. Do not activate an auto-starting service before this point.
3. Back up the now-closed database and existing environment/settings privately. Preserve saved session files, bindings, owner IDs and path overrides; do not initialize replacement state.
4. Activate the prepared generation, then run `systemctl --user daemon-reload` and `systemctl --user start agent-bridge` if activation has not started it already.
5. Wait for `agent-bridge status` to succeed, check the service PID, package, journal and persistent state, and test a saved conversation. Keep the previous executable available for rollback; stop the service before restoring a foreground daemon.

The daemon's optional owner notification provides a one-shot post-cutover check without another Telegram poller or an attached Pi session:

```sh
agent-bridge notify <configured-owner-ID> "The systemd bridge is ready."
```

It sends a plain DM through the running daemon, confirms only an acknowledged Telegram send, and never retries an uncertain outcome. It does not submit agent input. Other recipients and discovery-mode notifications are refused. Anyone with access to the private local control socket already has user-level bridge administration privileges; this is not a network notification API.

## Terminal sibling threads

Saved terminal sessions automatically register as sibling threads in a uniquely matching bound working directory. They appear in `/threads` and can communicate with scoped peers without replacing Main. Pi `/bot [platform/space/channel] [owner ID]` shows the current thread or disambiguates its project space/owner. `/where` reports the space key; its components are URL-encoded.

There are no public attachment commands or special owner-DM routes. After a clean terminal exit, bot input can reopen that exact saved session. A second writer is refused. Unexpected loss leaves an unconfirmed writer; reopen that same saved session and exit cleanly before continuing through the bot. Neither session switching nor reload may replace another thread's history.

Old recorded inputs are never replayed; the live inbox is not crash-durable. See [Pi integration](../bot.md).

## Bind a DM, group, or forum topic

Add the same bot to your group. Make it an administrator for message visibility, or disable privacy through BotFather and re-add it.

In the DM, group, or topic to activate (`/bind ~` is also valid):

```text
/bind@YourBot ~/dev/pi-tools
```

Replace `YourBot` with the bot username. Only configured owners can change bindings. The directory must exist on the daemon host.

Send ordinary input (or optionally mention the bot) to its saved default conversation:

```text
@YourBot fix the reconnect bug
```

Unthreaded messages—including voice notes—go to this topic's default conversation. Replies to mapped user or bot messages continue their exact conversation, even with another mention. Other unbound topics remain inactive. `/new` and the agent's `create_thread` tool create independent conversations.

The first request starts a native saved Pi session in the bound directory. Replies reopen its exact history after restart. Agents explicitly publish text with `reply_message` and contact peers with `message_thread`; ordinary assistant output stays private. A worker can choose another working directory, including an agent-created worktree. In a bound DM, plain input also goes to its default conversation.

`/new [request]` starts a separate saved thread. `/threads` lists Main and siblings with their activity. `/status`, `/model`, `/thinking`, `/compact`, and `/stop` target Main, or the exact thread selected by a tracked reply. They do not select the only active worker or create Main just for a control. Controls require the saved-session owner. Unknown explicit targets fail closed. `/unbind` cancels startup and live preparation while preserving history.

Sessions share normal filesystem access; there are no configured thread limits, project-wide serialization, or automatic worktrees. See [routing details](routing.md).

## Tools and voice messages

Managed and terminal threads have `list_threads`, `peek_thread`, `create_thread`, `message_thread`, `stop_thread`, and `reply_message`, plus `bot_attach`, typing, model/thinking pickers, media groups and session controls. Only explicit sends are published; ordinary text, thinking and tool results stay private in every project space, including DMs. See [routing and tool semantics](routing.md).

File downloads, sends, and voice transcription go through the daemon. The Pi audio and bot integrations share one `transcribe_audio` implementation; the bot integration supplies it when no audio transcription tool is already registered. Voice preprocessing always uses daemon transcription.

Whisper must be installed in the daemon's PATH. Home Manager's `programs.pi-tools.audioTranscription.enable` installs it. `AGENT_BRIDGE_WHISPER_MODEL` and `AGENT_BRIDGE_WHISPER_LANGUAGE` select voice defaults; the general `PI_WHISPER_*` variables are fallbacks. The Nix CLI provides FFmpeg.

## Inspect and stop

```sh
agent-bridge status
agent-bridge inspect
agent-bridge stop
```

`inspect` includes stored group-message text; review it before sharing. Ctrl+C also stops the foreground daemon. Pi disconnects automatically when its daemon connection closes.
