# Projects, conversations, and native Pi sessions

```text
chat/topic  -> project directory
conversation -> exact saved Pi session
```

The daemon hosts independent Pi SDK sessions in one process. Each explicitly uses `session.agent.toolExecution = "parallel"`: tool calls can run in parallel within a session, and independent conversations can run concurrently. There are no configured session caps, project-wide queues, subprocess workers, filesystem isolation, or automatic worktrees. Agents can create worktrees themselves.

## Bind and talk

A configured owner uses `/bind <directory>` in a DM, ordinary group, or forum topic. Paths are canonicalized on the daemon host. Telegram administrator status alone does not authorize local directory access.

In groups, mention the bot outside a tracked reply chain to create a conversation. Replies to mapped user or bot messages continue that conversation, including replies that mention the bot again. Ordinary group chatter does not join the latest conversation. Forum-topic creation messages are topic boundaries, not conversation parents.

In a bound DM, ordinary input continues its most recently created conversation. An explicit reply can select an older conversation. `/new [request]` creates a separate conversation in either scope; it does not reset or erase the old session.

The first input starts a native SDK session automatically. No terminal `/bot-connect task_<id>` ceremony is required. SQLite retains project bindings, message mappings, exact native session ID/file associations, and delivery metadata—not a second copy of Pi history. Conversations use `tasks`/`task_<id>` identifiers.

## Persistence and ordering

Sessions use Pi's normal saved JSONL files, auth, settings, model providers, tools, extensions, prompts, and skills. Noninteractive startup respects saved project trust; it does not approve confirmations. Only pi-tools' visible-session attachment extension is excluded from managed sessions. Managed attachment and transcription state is session-local.

Reconnection opens the exact mapped file; it never selects the most recent session. A mapped session requires its exact saved file path; ID-only associations are rejected. Missing or mismatched history fails explicitly rather than silently creating replacement history. A new session's native header is reserved before association is returned.

One creation promise per conversation prevents duplicate SDK sessions. Preparation retains FIFO ordering within that conversation; it does not serialize other conversations sharing its directory. The live inbox is not crash-durable: old recorded inputs are never replayed, and an interrupted input may need resubmission.

`/unbind` cancels pending startup and preparation, disconnects the chat/topic's sessions, and keeps history and saved associations. Rebinding another project does not transfer old conversations. Late startup/output cannot resurrect a released or unbound conversation, including unbind followed by rebinding the same project.

## Commands and ownership

`/start` and `/help` show help. `/where` shows the binding. Standalone group `/status` reports the project/backend/session count; reply `/status` reports that conversation's model and usage. `/model`, `/thinking`, `/compact`, and `/stop` act on a tracked reply, or the only active conversation; ambiguous scope produces an instruction instead of silently doing nothing. `/stop` also cancels media preparation and album debounce.

A configured conversation starter owns its controls; otherwise the first configured bot owner does. Other group members may submit input but cannot change models or abort that session. Each private conversation belongs to its own configured owner.

Optional visible Pi attachment remains available through `/bot-connect`. A second live writer/attachment is rejected by bridge session identity. Stop or relinquish the managed session before opening its file interactively; Pi session files must not have concurrent writers. Advanced `/release` explicitly clears an association and cancels startup; it is not required for ordinary `/new` or restart/resume.

## Boundaries

The runtime-neutral IPC core knows opaque routes and normalized agent capabilities. Telegram owns permissions, delivery, media, menus, and reply-chain mappings; the injected SDK backend owns native sessions. Assistant text and files stay in their conversation; thinking and tool results remain private. Herdr is not a runtime dependency. Telegram channel posts/comments and Discord are not supported.
