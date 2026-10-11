# Configuration and commands

## Environment

The daemon loads `$XDG_CONFIG_HOME/agent-bridge/env`, defaulting to `~/.config/agent-bridge/env`. Explicit environment variables take precedence. The file must be owned by the current user and private (mode `0600`). Projects and bindings live in SQLite, not a JSON configuration file.

| Variable | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token. Only the daemon uses it. Required to start the poller. |
| `AGENT_BRIDGE_OWNER_IDS` | Telegram user IDs separated by commas. Only these users can change topic bindings. |
| `AGENT_BRIDGE_ENV_FILE` | Optional private environment-file path override. |
| `AGENT_BRIDGE_SOCKET` | Optional IPC socket path. Export the same override in the daemon and Pi environments. |
| `AGENT_BRIDGE_DATABASE` | Optional SQLite path. Defaults to `agent-bridge/bridge.sqlite` under `XDG_DATA_HOME`, or `~/.local/share`. |

An empty owner list enables discovery mode. `/where` and `/help` remain available, but directory bindings and task routing are disabled.

## Chat commands

Commands accept a bot suffix, such as `/bind@YourBot ~/dev/pi-tools`. The adapter ignores commands addressed to another bot.

| Command | Result | Permission |
|---|---|---|
| `/bind <directory>` | Registers a directory and binds the current topic. | Bot owner |
| `/unbind` | Deactivates the topic, detaches live conversations, and retains history/session associations. | Bot owner |
| `/where` | Reports the community ID, topic ID, directory, and sender's user ID. | Any human |
| `/help`, `/start` | Reports the available commands. | Any human |
| `/new [request]` | Starts a separate saved conversation. | Human group member / configured DM owner |
| `/threads` | Lists Main and sibling saved threads with their activity. | Human member / configured DM owner |
| `/status` | Main's model/usage, or the exact replied thread's session status. | Saved-session owner |
| `/model`, `/thinking`, `/compact`, `/stop` | Controls Main, or the exact thread selected by a tracked reply. | Saved-session owner |

`/bind` accepts absolute paths, `~`, and paths that start with `~/`. Matching quotes allow spaces. The bridge resolves symlinks and checks that the directory exists. It does not run shell syntax, read repository contents, or create a worktree.

The same resolved directory has one project ID across topics. A topic cannot change directories without `/unbind`. A reply to an old task does not transfer that task to the new project.

Plain messages, including optional mentions, target Main in every bound space. Replies to mapped user or bot messages select their exact saved thread. Unknown explicit targets fail closed. Unknown slash commands receive a help hint rather than silently becoming agent input.

Bound threads automatically start/reopen independent native Pi SDK sessions with parallel tools. Exact session IDs and JSONL paths persist across restart. `/new [request]` creates a sibling without replacing Main. Saved terminal sessions register automatically in uniquely matching bound working directories; Pi `/bot [platform/space/channel] [owner ID]` reports the current thread or disambiguates registration. There are no public attachment commands or special owner-DM routes. Old recorded input is never replayed.

All human members in a bound topic can submit conversation input. Only the configured saved-session owner may operate session controls and menus. Community admin status does not grant permission to change bindings. Binding explicitly authorizes managed sessions and live input from that chat/topic. There are no configured session caps, project-wide serialization, filesystem isolation, or automatic worktrees.

## Telegram limits

The frontend accepts human input in ordinary groups and forum supergroups, plus configured-owner bound DMs. It excludes channel posts, bots, anonymous senders, and topic creation messages. DMs are ordinary bindable project spaces, including a binding to `~`. Edits are not replayed as new input.

A bot with privacy mode enabled can miss mentions and replies between users. Admin status provides broader visibility. Disabling privacy through BotFather requires re-adding the bot.

Project spaces support text, captions, media downloads, albums and voice transcription. Edits do not silently resubmit previously executed inputs. Telegram's UTF-16 entity offsets identify mentions and commands.

General has the internal topic ID `general`. Replies there omit the outbound `message_thread_id` parameter. The bridge does not create topics.

## SQLite state

| Table | Contents |
|---|---|
| `projects` | Project IDs, names, and resolved directories. |
| `bindings` | Selected topics and their project IDs. |
| `tasks` | Stable conversation IDs, project IDs, root messages, and creation times. |
| `task_attachments` | Each saved thread's exact session ID/file and authorized owner. |
| `default_threads` | Main per project-space binding. |
| `thread_settings` | Saved cwd and optional creating thread. |
| `visible_writers` | Durable unconfirmed terminal-writer leases. |
| `thread_anchor_claims` | One-shot terminal anchor claims, persisted before network publication. |
| `message_routes` | User and bot message IDs associated with tasks. |
| `inputs` | Task messages in sequence order. |
| `transport_cursors` | Polling offsets and their last update times. |
| `outbox` | Replies, delivery states, attempts, and retry deadlines. |

SQLite commits routing, input records, reply enqueueing, and cursor advancement together. The sole poller processes updates in order; its committed offset deduplicates replay without retaining a per-update ledger. The watermark cannot regress within an active epoch. Offsets expire after six idle days, before Telegram can reset update IDs after a week. Additive tables are created when the store opens; there is no general migration engine for incompatible historical schemas.

Database files have mode `0600`. New database directories have mode `0700`. The bridge refuses database file links and directory paths that another user can replace. It does not change an existing parent directory's permissions.

Valibot validates Telegram responses and SQLite rows. Internal IDs have distinct branded types. The router uses discriminated message routes.

## Delivery and process limits

The durable acknowledgement/control reply loop waits 3.1 seconds between send attempts. Explicit thread replies use the transport's chunking and delivery guards; ordinary assistant output stays private. Replies keep their topic and anchor. Deleted anchors fail delivery instead of producing an unthreaded reply.

Before calling Telegram, the outbox durably marks the reply as non-retryable (`failed`, with an unconfirmed-outcome explanation). A successful send changes it to `sent`. Only a transport failure known to be safe to retry can return it to `pending`; explicit rate limits set the retry delay. Errors `400` and `403` and uncertain creation outcomes remain `failed`, without automatic resend. A database error after an accepted send is not a transport failure and never requeues that send.

If a reply reaches users before the send result commits, the bridge can recover its task mapping from the saved acknowledgement text. Recovery requires that the parent message came from this bot and that the text identifies exactly one distinct conversation. Ambiguous identical replies remain unmapped. If the process crashes after claiming an outbox reply, that reply is not automatically resent; it may be missing if the crash preceded publication. This deliberately prefers a missing acknowledgement to duplicate creation.

The poller stops on authentication error `401` or polling conflict `409`. It refuses configured webhooks. Telegram retains incoming updates for at most 24 hours.

The daemon supports one process per bot and database. It uses an `agent-bridge-telegram-` per-bot connection lock, preventing simultaneous current-version daemons even across token rotation. It does not share the older Pi poller's lock namespace: stop any older poller before starting this daemon. Cross-version locking and old configuration readers are not supported. Linux and Windows release ownership on process exit. Other systems can retain a filesystem socket after a crash.

`agent-bridge notify <owner ID> <text>` uses the running daemon's private control socket to send a one-shot plain DM to a configured owner. It needs no agent attachment and never polls Telegram itself. Text must be nonblank and at most 4,000 UTF-16 code units. Delivery uncertainty is reported without automatic resend; the CLI exits nonzero on refusal or failed acknowledgement. Notifications are disabled in discovery mode and cannot address arbitrary chats. They are not conversation inputs or durable outbox entries.

On Linux, Home Manager's `programs.pi-tools.agentBridge.service.enable` optionally manages the daemon as a systemd user service. CLI installation alone does not start it. See [service setup and foreground cutover](telegram.md#home-manager-user-service-linux).

The bridge has no HTTP API. A private local socket carries prepared prompts, normalized output events, agent capability requests, attachment delivery, transcription, and owner-only administrative notifications. The portable client supports other agent backends without importing Pi. Telegram API methods and wire updates stay inside the daemon. Logs contain event names, task IDs, and input sequence numbers without message text or tokens. `inspect` includes stored message text.
