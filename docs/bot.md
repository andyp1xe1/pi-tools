# Pi bot integration

`extensions/bot.ts` registers the Pi integration from `src/bot/`. It uses the portable `src/agent-bridge/client.ts` over a private local socket. The [daemon](agent-bridge/reference.md) owns credentials, platform traffic, media preparation, menus, and delivery. Pi never polls Telegram or starts the daemon.

See [Telegram setup](agent-bridge/telegram.md), [project/thread routing](agent-bridge/routing.md), [Discord adapter status](agent-bridge/discord.md), and [code boundaries](architecture.md).

## Terminal sessions are saved threads

A saved terminal session automatically registers as a sibling thread when its canonical working directory matches exactly one bound project space and a single owner can be selected. It appears in `/threads` and `list_threads`, can inspect and message scoped peers, and can continue through the bot after a clean terminal exit. It does not replace Main.

There is one Pi command:

```text
/bot [platform/space/channel] [owner ID]
```

Without arguments, `/bot` reports the current thread or attempts registration. Supply the space key reported by `/where` when several spaces bind the same directory; supply an owner ID when several owners are configured. Components are URL-encoded, for example `discord/dm%3A123/123`. A saved session cannot move to another project space or replace another thread's history.

There is no public attach/detach/release workflow. Registration requires a saved session file, matching cwd and current binding. IPC registration remains an internal writer lease: only one writer may own each saved session. Unexpected socket/process loss leaves an unconfirmed terminal-writer lease. Reopen that exact saved session and exit cleanly before bot-managed continuation; an uncertain writer is never silently replaced.

Reload restores only the same saved identity. `/new`, `/resume`, and `/fork` never inherit the previous thread selection. A different saved terminal session may register independently in its own matching space. Registration errors do not start an automatic retry loop.

## Socket path

Pi and the daemon must run as the same local account and use the same path:

1. `AGENT_BRIDGE_SOCKET` override.
2. `$XDG_RUNTIME_DIR/agent-bridge.sock`.
3. `$XDG_DATA_HOME/agent-bridge/agent-bridge.sock`.
4. `~/.local/share/agent-bridge/agent-bridge.sock`.

## Chat commands and targeting

DMs, groups, and forum topics are ordinary bindable project spaces. `/bind ~` is valid in a configured owner's DM.

- `/help`, `/start`: help; `/where`: directory, space key and user ID.
- `/bind <directory>`, `/unbind`: owner-only project binding controls.
- `/new [request]`: a separate saved thread without replacing Main.
- `/threads`: Main and siblings, including running, idle, starting, stopped and unconfirmed states.
- `/status`, `/model`, `/thinking`, `/compact`, `/stop`: Main unless sent as a tracked reply, which selects that exact thread. Controls require the configured saved-session owner. They do not create Main merely to inspect or stop it.

Plain input always targets Main. Replies to mapped user or bot messages target their exact saved thread. Unknown explicit targets fail closed; the bot never guesses another conversation. Telegram retains model/thinking menus; the Discord adapter uses textual values.

Controls bypass slow media preparation. `/stop` cancels queued startup, input, albums, downloads, authentication and active SDK work without letting late completions reappear. Future input may continue the saved thread. `stop_thread` also unloads the writer. `/unbind` unloads this space's writers while retaining history and associations.

## Explicit communication and private output

All registered threads use `reply_message` to publish user replies and `message_thread` to send peer input. Ordinary assistant text, thinking and tool results remain private in native history, including terminal-native turns. Busy/settled events update status without publishing their content. Completing a delegated turn does not notify its parent automatically: report results explicitly.

`list_threads`, `peek_thread`, `create_thread(cwd, title, text)`, and `stop_thread` provide scoped discovery, bounded read-only history, delegation and cancellation. Tools cannot reach another project space. A worker may choose an existing cwd outside the bound repo, including an agent-created worktree.

The daemon owns reply anchors, mentions, chunking and message mappings. Every acknowledged outgoing chunk is mapped even if a later chunk fails. Uncertain creation outcomes are not automatically resent, and uncertainty survives IPC error reporting. Terminal anchor publication is claimed persistently before sending; reconnect does not retry a possibly delivered anchor.

## Files and voice

`bot_attach` resolves relative paths against `ctx.cwd` and asks the daemon to send regular local files to the registered thread. Pi cannot supply arbitrary chat IDs. Telegram uploads have a 50 MiB limit, bounded cancellable reads, and at most two simultaneous uploads.

The Telegram daemon downloads incoming voice and runs Whisper with daemon defaults. Prepared prompts contain a transcript or bounded failure detail and local attachment paths. Long transcripts link to the complete private local file.

Pi registers daemon-backed `transcribe_audio` if the tool does not already exist. It accepts model/language overrides and cancellation; output is bounded to 2000 lines or 50 KiB with a complete local file when truncated. The standalone audio extension captures the active bridge provider before asynchronous validation. While registered it delegates to the daemon; otherwise it uses local Whisper. Daemon failures never trigger local fallback. Discord inbound media/voice remains a host-integration limitation documented separately.

## Input and handoff guarantees

Prepared input reserves a FIFO position before image reads and async model/auth checks. Pi receives custom messages with validated opaque turn IDs and retains them until matching `message_start` acknowledgement. Preflight failure or settlement without acknowledgement reports failure once and releases the FIFO rather than replaying uncertain work. Compaction success and failure both resume delivery after Pi becomes idle. Recorded inputs are not crash-replayed.

Handoff invalidates stale tool/provider captures, clears native and bridge queues, aborts the terminal run, waits for full settlement and started model/compaction mutations, then confirms release to the daemon. Failed queue clearing keeps the handoff barrier closed. Reload cannot register a replacement writer before this barrier completes.

## IPC limits

| Limit | Value |
| --- | --- |
| NDJSON frame | 1 MiB |
| Registration timeout | 10 seconds |
| Disconnect fallback | 1 second |
| Tool request timeout | 60 seconds; transcription 6 minutes |
| Client pending tool calls | 256 |
| Daemon active tool calls | 32 per writer; 128 tracked jobs globally |
| Pending reverse agent commands | 32 per writer |
| Simultaneous daemon transcriptions | 2 |
| Pending frontend messages | 64 per writer |

Invalid frames, unsolicited reply IDs, timeouts and socket closure reject pending calls. Cancellation aborts the exact daemon request. Cancellation cannot undo a send already accepted by a platform.

[Telegram attribution](../src/agent-bridge/telegram/NOTICE.md).
