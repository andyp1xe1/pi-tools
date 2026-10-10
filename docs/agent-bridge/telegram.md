# Run the Telegram daemon

The daemon owns the bot and automatically hosts native saved Pi SDK sessions. Sessions use a private local socket; they do not hold its token or poll Telegram. Independent conversations and each session's tool calls run in parallel.

## Configure a bot directly

The daemon automatically loads `$XDG_CONFIG_HOME/agent-bridge/env`, defaulting to `~/.config/agent-bridge/env`. Explicit environment variables take precedence.

```sh
mkdir -p ~/.config/agent-bridge
install -m 600 docs/agent-bridge/env.example ~/.config/agent-bridge/env
```

Set `TELEGRAM_BOT_TOKEN` and `AGENT_BRIDGE_OWNER_IDS` in that file. Keep credentials outside shared checkouts. The configuration must be owned by you and private.

Without owners, the bot reports your ID in a DM or `/where` in a group/topic. Set the reported ID and restart before routing tasks or attaching Pi. No stranger can pair themselves by sending the first message.

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
  bot.enable = true; # Optional commands for visible Pi attachments
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

## Optional visible Pi attachments

- `/bot-connect` attaches the current Pi session to the sole configured owner's DM.
- `/bot-connect <user ID>` selects a DM owner when several are configured.
- `/bot-connect task_<id> [user ID]` attaches the current session to a group conversation. Pi must run in that conversation's bound project directory.
- `/bot-disconnect` detaches without stopping the daemon.
- `/bot-status` reports the attachment state.
- These are optional host-side commands, not Telegram commands. Normal managed conversations require no terminal attachment.
- Telegram `/new [request]` creates a separate saved conversation instead of resetting an attached thread.

A second live attachment for the same conversation is refused. Different group conversations may attach different saved sessions for the same owner. A session associated with a group conversation cannot also attach an owner DM.

Explicit visible-session DM inputs received while detached are not queued. Managed conversations start/reopen automatically for new input. Old recorded inputs are never replayed; the live inbox is in-memory, not crash-durable.

## Bind a DM, group, or forum topic

Add the same bot to your group. Make it an administrator for message visibility, or disable privacy through BotFather and re-add it.

In the topic to activate:

```text
/bind@YourBot ~/dev/pi-tools
```

Replace `YourBot` with the bot username. Only configured owners can change bindings. The directory must exist on the daemon host.

Mention the bot to start a task:

```text
@YourBot fix the reconnect bug
```

Mentioning the bot outside a tracked chain starts a conversation. Replies to mapped user or bot messages continue it, even when they mention the bot again. Other topics remain inactive.

The request immediately starts a native saved Pi session in the bound directory. Replies reopen its exact history after restart; assistant output and files remain in its reply chain. In a bound DM, plain input continues the latest conversation.

`/new [request]` starts a separate conversation. `/status` works at topic level or as a conversation reply. `/model`, `/thinking`, `/compact`, and `/stop` select the replied conversation or the only active one; otherwise the bot asks you to reply. Controls remain owner-only. `/unbind` cancels startup and live preparation while preserving history.

Sessions share normal filesystem access; there are no configured thread limits, project-wide serialization, or automatic worktrees. See [routing details](routing.md).

## Tools and voice messages

Attached Pi sessions retain `bot_attach`, streaming replies, typing, model/thinking pickers, media groups, and Telegram session controls. Only assistant text is published; thinking and tool results stay private.

File downloads, sends, and voice transcription go through the daemon. The Pi audio and bot integrations share one `transcribe_audio` implementation; the bot integration supplies it when no audio transcription tool is already registered. Voice preprocessing always uses daemon transcription.

Whisper must be installed in the daemon's PATH. Home Manager's `programs.pi-tools.audioTranscription.enable` installs it. `AGENT_BRIDGE_WHISPER_MODEL` and `AGENT_BRIDGE_WHISPER_LANGUAGE` select voice defaults; the general `PI_WHISPER_*` variables are fallbacks. The Nix CLI provides FFmpeg.

## Inspect and stop

```sh
agent-bridge status
agent-bridge inspect
agent-bridge stop
```

`inspect` includes stored group-message text; review it before sharing. Ctrl+C also stops the foreground daemon. Pi disconnects automatically when its daemon connection closes.
