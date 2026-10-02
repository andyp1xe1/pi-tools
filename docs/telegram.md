# Telegram bridge

The bridge forwards private Telegram messages into a connected Pi session and streams its replies.

Enable it with Home Manager:

```nix
programs.pi-tools = {
	enable = true;
	telegram.enable = true;
	audioTranscription.enable = true;
};
```

In Pi, run `/telegram-setup`, then `/telegram-connect`. The setup stores secrets and pairing state in `~/.pi/agent/telegram.json`, outside Nix.

- `/telegram-disconnect` stops polling.
- `/telegram-new` starts a fresh Pi session and reconnects.
- `/telegram-status` shows the connection state.

Only one local Pi session can connect to a bot. Disconnect that session before connecting another. Conflicts with clients on other machines stop the bridge.

Replies update in place. Thinking and tool results stay private. Voice messages include transcripts when audio transcription is enabled.

Messages received during compaction wait in memory. Disconnect pauses the queue. Session shutdown clears it.

Telegram commands include `/new`, `/model`, `/thinking`, `/status`, `/compact`, and `/stop`. See [the architecture](architecture.md) for lifecycle details and [the notice](../src/telegram/NOTICE.md) for attribution.
