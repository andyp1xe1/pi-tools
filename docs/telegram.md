# Telegram bridge

The Telegram bridge forwards private messages into one connected pi session and streams replies back. See [`src/telegram/NOTICE.md`](../src/telegram/NOTICE.md) for attribution.

## Enable with Home Manager

```nix
programs.pi-tools = {
  enable = true;
  telegram.enable = true;
  audioTranscription.enable = true; # Optional voice transcription
};
```

After activating the configuration, start pi and run:

```text
/telegram-setup
/telegram-connect
```

The first command stores the bot configuration in `~/.pi/agent/telegram.json`. Runtime configuration, pairing state, and secrets remain outside Nix.

## Voice messages

With audio transcription enabled, voice prompts include a transcript and the original path. Other audio files remain attachments until pi calls `transcribe_audio`.

## Commands

The bridge registers `/start`, `/help`, `/new`, `/model`, `/thinking`, `/status`, `/compact`, and `/stop` with Telegram when it connects. Model and thinking commands use Telegram button menus. `/new` starts a clean pi thread and reconnects the bridge. Messages received during compaction are held until compaction finishes.

- `/telegram-setup` — configure the bot token.
- `/telegram-connect` — connect the current pi session.
- `/telegram-disconnect` — stop polling.
- `/telegram-new` — start a new pi thread and reconnect the bridge.
- `/telegram-status` — show bridge status.

Inside Telegram, the registered commands are handled directly by the bridge.
