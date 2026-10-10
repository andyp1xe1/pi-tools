# Pi bot integration

`extensions/bot.ts` registers the Pi integration from `src/bot/`. It uses the portable `src/agent-bridge/client.ts` over a private local socket. The [daemon](agent-bridge/reference.md) owns bot credentials, Telegram traffic, permissions, preparation, menus, and output delivery. Pi never polls Telegram or starts the daemon.

See [Telegram setup](agent-bridge/telegram.md) for configuration and startup and [code boundaries](architecture.md) for the two modules.

## Pi commands

| Command | Behavior |
| --- | --- |
| `/bot-connect [task_<id>] [owner ID]` | Attach this Pi session to a group conversation, or omit the task ID for the owner's DM. Multiple owners require an explicit owner ID. |
| `/bot-disconnect` | Clear attachment intent and detach. The daemon stays active. |
| `/bot-status` | Show local state, frontend identity, conversation route, owner, pending input, and last error. |
| `/bot-new` | Create and reattach a new Pi session for a DM route. Group routes require explicit release and replacement. |

All Pi attachments require a saved session. Each conversation has at most one live session; different group conversations can have independent sessions for the same owner. Explicit visible-session DMs use separate owner routes. Group conversations retain their saved session association after disconnect. Telegram `/start` cannot change permissions or pairing. See [project and thread routing](agent-bridge/routing.md).

## Socket path

Pi and the daemon must run as the same local account and use the same path:

1. `AGENT_BRIDGE_SOCKET` override.
2. `$XDG_RUNTIME_DIR/agent-bridge.sock`.
3. `$XDG_DATA_HOME/agent-bridge/agent-bridge.sock`.
4. `~/.local/share/agent-bridge/agent-bridge.sock`.

## Telegram commands and input

Managed conversations start automatically after Telegram `/bind <directory>`; their exact native JSONL history resumes after restart. The optional Pi commands above still attach a visible session. The daemon handles Telegram messages, albums, commands, and callbacks in each conversation. It sends Pi prepared text and local image-file paths, not raw Telegram updates. Pi converts the files into its content format. Group replies remain anchored in the same project topic and conversation.

- `/help` and `/start`: command help.
- `/new [request]`: start a separate managed conversation without resetting an old thread (explicit visible-session DMs retain reattachment).
- `/model` and `/thinking`: daemon-rendered menus backed by Pi capabilities.
- `/status`: Pi model, usage, cost, and context.
- `/compact`: request compaction when Pi is idle.
- `/stop`: abort a running turn, including one active during reload.

Controls bypass slow download/transcription work. Album and voice preparation preserve arrival order. Group conversation controls are restricted to the attachment owner; ordinary members may submit conversation input. Groups and bound DMs use automatic native SDK sessions with parallel tools. `/start` aliases help; `/status` has topic diagnostics; ambiguous controls ask for a conversation reply. `/stop` cancels outstanding media preparation as well as SDK work. See [managed routing](agent-bridge/routing.md).

## Output

Pi emits normalized text and lifecycle events. The daemon handles Telegram chunking, streamed edits, typing indicators, error replies, and message IDs. Only assistant text is forwarded; thinking and tool results remain private. Terminal-originated output is not published unless it belongs to an acknowledged bot turn.

## Agent tools and voice

`bot_attach` resolves relative paths against `ctx.cwd` and requests immediate delivery of absolute local files. The daemon selects the attached conversation's recipient and thread; Pi cannot supply arbitrary chat IDs. Uploads require regular local files of at most 50 MiB, with bounded cancellable reads and at most two simultaneous uploads. The tool works from Telegram and terminal prompts while attached.

The daemon downloads incoming voice messages and executes Whisper with daemon-configured defaults. Prepared prompts include a transcript or failure detail and local attachment paths. Long voice transcripts are truncated in the prompt with a link to their complete private local file.

At startup, Pi registers daemon-backed `transcribe_audio` if that tool does not already exist. It accepts a local path and optional model/language overrides, supports cancellation, and truncates tool output at 2000 lines or 50 KiB, saving complete output locally.

The standalone audio extension captures the active bridge provider before asynchronous validation. While attached it delegates to the daemon; while detached it uses local Whisper. Daemon failures never trigger local fallback. No duplicate transcription tool is registered.

## Optional manual session lifecycle

The Pi inbox submits prepared input as custom messages with validated opaque turn IDs. It retains input until matching `message_start` acknowledgement, independent of text-transforming input hooks. Asynchronous model/auth preflight and settlement without acknowledgement report delivery failures and release the FIFO without retrying the same message. Custom submission bypasses Pi's `input` and `before_agent_start` hooks; registered tool prompt guidance still applies. It uses steering during active turns and waits through compaction, including failed compaction. Image-file reads reserve their position before asynchronous work. Unrelated terminal or extension input ends bot attribution before subsequent output.

After successful `/bot-connect`, validated process memory retains the selected route and owner during lifecycle handoff. Reload can reconnect the same saved group session; switching to a different session cannot silently replace a durable group association. DM routes retain reattachment across `/new`, `/resume`, `/fork`, and `/reload`. Session history never authorizes attachment, and a fresh Pi process starts detached.

Handoff waits for started Pi model changes and requested compaction, then for daemon release acknowledgement or socket closure. Detach has a one-second fallback. Explicit disconnect, quit, failed attachment, and unexpected socket closure clear intent. There is no automatic retry loop after failure.

Detach clears both sides' pending input and reply attribution and cancels daemon preparation, typing, menus, and queued previews. Already submitted Pi input may finish locally, but its output cannot cross into a new attachment. Manual reconnect waits for old submitted input to settle; active reload holds new input until the old run is idle. Inbox state is not crash-durable.

## IPC limits

| Limit | Value |
| --- | --- |
| NDJSON frame | 1 MiB |
| Attach timeout | 10 seconds |
| Detach fallback | 1 second |
| Tool request timeout | 60 seconds; transcription 6 minutes |
| Client pending tool calls | 256 |
| Daemon active tool calls | 32 per attachment; 128 tracked jobs globally |
| Pending reverse agent commands | 32 per attachment |
| Simultaneous daemon transcriptions | 2 |
| Pending frontend messages | 64 per attachment |

Invalid frames, unsolicited reply IDs, timeouts, and socket closure reject pending calls and detach. Request cancellation aborts the exact daemon controller; detach aborts the attachment's requests. Large tool transcripts return a private file reference rather than an oversized frame.

Uncertain Telegram creation outcomes are not automatically resent. Explicit rate-limit rejections may retry. Cancellation cannot undo an upload already accepted by Telegram.

[Telegram attribution](../src/agent-bridge/telegram/NOTICE.md).
