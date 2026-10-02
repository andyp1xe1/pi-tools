# Code boundaries

Every pi extension uses the same structure:

- `extensions/<name>.ts`: pi's default-export entrypoint, with an explicit `register…(pi)` call. No business logic or background work.
- `src/<name>/index.ts`: named registration function connecting tools, commands, and lifecycle handlers to the implementation.
- `src/<name>/`: implementation and reusable helpers. Import these modules directly when building other integrations; importing them does not register an extension.
- `tests/`: behavior tests and entrypoint/registration smoke tests.

Registration may live in `src/`, but it is always invoked visibly from `extensions/`. Avoid putting implementations back into entrypoints or hiding registration behind default re-exports.

## Telegram lifecycle

The bridge composes three responsibilities, protected by one connection owner:

### Connection ownership

`connection.ts` acquires a per-bot OS socket before polling, registering commands, or writing connection configuration. A second local session refuses to connect. Ownership is released after polling and in-flight output stop. Linux abstract sockets and Windows pipes release even on a process crash; other platforms may require removing a stale filesystem socket after a crash.

This is a local lock, not a distributed lease. A Telegram HTTP 409 conflict from another machine stops polling rather than entering a reconnect fight.

### Incoming messages

`inbox.ts` keeps one FIFO of prepared Telegram turns. Only one submission may await acknowledgement at a time. `message_start` for the matching user message acknowledges delivery and supplies its chat/reply metadata.

Pi's `sendUserMessage()` is fire-and-forget: its return is not an acknowledgement. The inbox retains a submitted item until pi starts it. Asynchronous preflight errors are reported by pi; the bridge must not blindly resubmit an unacknowledged item and risk duplicates.

During compaction or other non-streaming busy states, messages wait. Compaction outcome hooks schedule delivery, never submit within the hook: pi may still have its compaction controller set. During an active agent run, new messages use steering.

Disconnect pauses the inbox; reconnecting that session resumes pending messages. Session shutdown clears this in-memory queue. It is not a durable inbox across process exits.

### Assistant output

`preview.ts` maps each assistant message to stable Telegram messages:

1. `message_start` opens an output state.
2. `message_update` coalesces streamed text and schedules throttled sends/edits.
3. `message_end` queues the final edit and closes that state.

All output operations are serialized, including across assistant messages. Closing a state cancels stale scheduled updates but waits for any in-flight send. Replies exceeding Telegram's limit stream into additional bubbles without replacing existing ones.

Only text blocks are forwarded. Commentary/planning text is visible; internal thinking and tool results are not. Aborted partial replies remain in place. Ephemeral drafts, blank messages, and artificial “…” placeholders are not used.

### Activity

`agent_start` enables steering and abort control. Acknowledged Telegram turns start the typing indicator. `agent_settled` stops typing and releases turn metadata; it does not rebuild or resend assistant text. Terminal errors are announced after retries finish.

Polling, pi execution, and Telegram message completion are distinct lifecycles. Keep them distinct when adding new integrations.
