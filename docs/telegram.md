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

## Streaming and connection ownership

Streaming uses real Telegram messages: each assistant text message is sent once, then edited in place as it grows. Commentary/planning text and final answers have separate bubbles. Long replies continue in additional bubbles. Thinking and tool results remain invisible; activity uses the typing indicator, not blank or “…” placeholder messages. Aborted partial replies remain in place.

Only one local pi session can connect to a given bot. A second `/telegram-connect` refuses before touching Telegram or updating configuration; disconnect the owner first. On Linux, the ownership lock also releases on a process crash. Polling conflicts with clients on other machines stop the bridge instead of retrying forever.

Messages waiting during compaction are queued in order and delivered when pi can safely accept them. Disconnect pauses pending input; reconnecting that session resumes it. The queue is in memory and is cleared on session shutdown.

See [Code boundaries and Telegram lifecycle](architecture.md) for the implementation model.

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
