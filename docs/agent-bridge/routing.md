# Projects, conversations, and native Pi sessions

```text
chat/topic -> project directory + saved default Pi conversation
conversation -> exact saved Pi session + its own working directory
```

The production frontend is Telegram. The shared routing core also represents Discord channels/native threads and Slack channels/threads; those platform adapters are not shipped yet.

## Bind and talk

A configured owner uses `/bind <directory>` in a DM, ordinary group, or forum topic. The directory is canonicalized on the daemon host. Telegram administrator status alone does not authorize local directory access.

Every ordinary unthreaded message received in a bound space goes to its default conversation, including voice notes. An @mention is optional. Replies to mapped user or bot messages continue their exact conversation, bypassing the default. Replying to an untracked human message goes to the default; an unrecognized bot reply is not guessed into another conversation. Forum-topic creation messages are boundaries, not conversation parents. Unbound spaces remain inactive. BotFather privacy must be disabled (or the bot made an administrator) for Telegram to deliver ordinary group messages.

The default is per chat/topic and project binding, not per directory: two topics using the same repo have separate default conversations. `/new [request]` starts an independent conversation without replacing the default or erasing old sessions. Plain messages in bound DMs also go to their default rather than the most recently created worker.

Each first input starts a native SDK session automatically. SQLite retains project bindings, message mappings, native session ID/file associations, per-thread cwd and optional creator, and default-conversation mappings—not a second copy of Pi history. Existing `tasks`/`task_<id>` identifiers are preserved.

## Explicit communication tools

Managed conversations and visible `task_` attachments have these tools:

| Tool | Behavior |
| --- | --- |
| `list_threads({limit?, before?})` | Page through this bound project space's threads: ID, title, cwd, running/idle/stopped status, default and current flags. `unconfirmed` means a disconnected visible writer has not proved it stopped. Default page size 50; use the final returned ID as `before`, continuing until an empty page. |
| `peek_thread({threadId, limit?, before?})` | Read status and recent native history without waking the agent. Default 20 entries; `nextBefore` fetches older entries. Thinking, tool arguments and raw tool output are omitted. Explicit sends are readable. |
| `create_thread({cwd, title, text})` | Create an independent saved conversation and enqueue its first instructions. The cwd must already exist; the agent may create a worktree first. A small title message provides its Telegram reply anchor. Returns a thread ID, not the task's eventual result. |
| `message_thread({threadId, text})` | Enqueue a peer message, reviving a stopped thread when necessary. Returns acceptance, not an answer. |
| `stop_thread({threadId})` | Cancel preparation, queued input and active work, then unload the session. History, cwd and reply mappings remain. A later direct reply or peer message reopens the exact session. Self-stop is rejected. |
| `reply_message({messageId, text, mentions?})` | Explicitly publish a user reply. Use the platform message ID in an input envelope, not a Pi history entry ID. Mentions use known user IDs, not usernames or thread IDs. |

Conversation tools cannot reach another topic, chat, or project binding. A new thread can choose a cwd outside the bound repo, while retaining its originating project space for communication and access checks. Tools capture attachment identity so late work cannot publish through a replacement attachment.

Ordinary assistant text stays private in saved Pi history. User-visible text requires `reply_message`; files use `bot_attach`. Agent-to-agent communication requires `message_thread`. Finishing a turn changes running to idle but does not translate a generic output into a completion event. A worker explicitly messages its requester when it wants to report progress or results. There is no permanent parent subscription or separate task-memory system.

## Minimal message provenance

User input contains one short line, omitting absent names and reply targets:

```text
[telegram from="@moss" user=7 message=93 reply=91]
Can you check this?
```

Peer messages identify only the sending conversation:

```text
[thread from=task_<id>]
The tests passed.
```

The bridge authors these fields; message text remains ordinary untrusted input. Own thread identity/default role is supplied through native session prompt guidance, and `list_threads` identifies the current thread. Forwarding text does not impersonate its original user: the forwarding agent remains the peer sender.

## Persistence, ordering, and compaction

Sessions use Pi's saved JSONL files, auth, settings, providers, tools, extensions, prompts and skills. Noninteractive startup respects saved project trust and does not approve confirmations. Only pi-tools' visible-session attachment entrypoint is excluded from managed sessions. Managed attachment and transcription state is session-local.

Reconnection opens the exact associated file; it never selects the newest session. Missing or mismatched history fails explicitly instead of creating a replacement. A new native header is reserved before its association is returned. Stopped-history inspection is read-only and does not migrate or rewrite the file.

One creation promise per conversation prevents duplicate sessions. Accepted user and peer input shares a FIFO through startup and media preparation. Controls bypass media work. Stop/unbind fences input already waiting for shutdown, and late startup/output cannot resurrect it—even after rebinding the same project. Live input queues are not crash-durable: recorded input is never replayed after a restart.

Default managed conversations use Pi's native compactor with a session-only threshold near 30% of the selected model's context window and a smaller retained tail. Worker sessions keep normal compaction settings. Existing compaction enable/disable preferences are respected; global settings are not rewritten. Native JSONL history retains the full conversation.

## Commands and ownership

`/start` and `/help` show help. `/where` shows the binding. Standalone group `/status` reports project/backend/session count; reply `/status` reports that conversation's model and usage. `/model`, `/thinking`, `/compact` and `/stop` select a tracked reply or the only active conversation; ambiguity asks the user to reply. In a bound DM, unthreaded controls select the default conversation. Telegram `/stop` aborts the turn but keeps the conversation available; the agent tool `stop_thread` also unloads it.

A configured conversation starter owns its controls; otherwise the first configured bot owner does. Other group members may submit input but cannot directly change models or abort a session. Each private conversation belongs to its configured owner.

`/unbind` cancels startup and live preparation, disconnects this space's sessions, and keeps history and associations. Rebinding another project never transfers old conversations. Advanced `/release` explicitly clears a saved association for deliberate replacement; it is not required for ordinary stop/revive or `/new`.

Optional visible attachment uses `/bot-connect`. A second writer is rejected by bridge session identity. Stopping a visible thread waits for agent abort before detaching and permitting managed revival; detach also stops that visible task's bot work. Unexpected visible-session EOF or daemon loss keeps a durable writer lease: automatic revival is blocked until that visible session reconnects and confirms a clean handoff, or `/release` chooses a new saved file. Never independently open a live session file for another writer.

The daemon hosts independent SDK sessions in one process, with parallel tools per session and no session caps, project-wide queues, subprocess workers, filesystem isolation, automatic worktrees or filesystem coordinator. Agents decide whether to handle quick work themselves, delegate sustained work, and coordinate shared-resource changes. Herdr is not a runtime dependency.
