# Code boundaries

Extension entrypoints under `extensions/` only call named registration functions. Implementations and reusable helpers live under `src/`; importing them does not register an extension.

## Bot infrastructure and Pi integration

```text
src/agent-bridge/
  daemon.ts          Bun CLI lifecycle and the sole Telegram poller
  server.ts          Node-compatible private IPC, ownership, cancellation and reverse RPC
  frontend.ts        injected agent capabilities and conversation frontend boundary
  protocol.ts        runtime-neutral validated contracts
  client.ts          portable IPC and active transcription backend registration
  config.ts          private environment loading, data-path preparation and daemon config
  telegram/          Telegram authorization, routing, HTTP, media, menus and streaming
  store.ts           project/conversation/session associations and durable reply outbox

src/bot/
  index.ts           Pi registration
  session-adapter.ts visible Pi attachment lifecycle
  delivery.ts        shared preparation, preflight, acknowledgement, cancellation and output attribution
  controls.ts        shared reverse-RPC validation, model selection and busy policy
  inbox.ts           ordered Pi submission and message_start acknowledgement
  messages.ts        prepared files to Pi content; Pi messages to plain text
  status.ts          Pi model, thinking, usage, and context snapshots
  tools.ts           attachment tool wrappers around the IPC client
  thread-tools.ts    explicit communication tools and bounded native-history projection
```

`extensions/bot.ts` calls `registerBot()` for optional visible-session attachments. The CLI composition root injects `src/pi-backend/index.ts`: independent native SDK sessions with explicit `agent.toolExecution = "parallel"`, normal JSONL/auth/resources, and per-session bridge tools. Runtime-neutral daemon/IPC infrastructure does not import the SDK or `src/bot/`. The IPC server receives a frontend implementation rather than importing Telegram or SQLite. The Pi integration imports only `agent-bridge/client.ts` and `agent-bridge/protocol.ts`, never the daemon, SQLite, or Telegram HTTP helpers. Boundary tests enforce those dependencies.

Channels/topics bind to project directories and saved default conversations; tracked replies/native threads select independent saved sessions. Each worker persists its own cwd, optionally an agent-created worktree. The existing `task_<id>` conversation identifiers preserve history rather than introducing a separate task lifecycle. Live attachments are keyed by conversation route, not owner. Group attachment validates Pi's canonical working directory and current project binding. Owners authorize attachment and controls; they are not the session routing key. Bound DMs also receive managed conversations; explicit visible-session owner DMs use separate routes. The running daemon always has a native session backend; visible attachments are optional routes within that same daemon, not a second manual-only operating mode. Recognized Telegram commands have the same meaning with or without a visible attachment. Managed startup is single-flight per route, not serialized per project; opaque startup tokens and lifecycle generations fence input and attachment after stop/release/unbind, including input waiting for an earlier shutdown. No process workers, session caps, sandboxing, or automatic worktrees are added.

## IPC contract

The daemon sends prepared prompts: opaque turn IDs, text, and absolute image-file paths. Image bytes do not travel in JSON; Pi reads the local files into its image content type.

Pi implements agent capabilities through reverse RPC: snapshot, bounded history peek, model selection, thinking selection, abort, compaction, and new session. The daemon renders Telegram commands and menus using those capabilities. It does not receive model credentials or invoke Pi APIs.

Pi sends normalized acknowledgement, settlement and delivery-error events. Managed/task hosts suppress ordinary text events. Their agents explicitly request user replies, peer messages, thread creation/inspection/stop, attachments or transcription—not arbitrary platform API calls. Minimal input envelopes expose sender and replyable message IDs; credentials, raw updates and wire API methods remain daemon-owned. The frontend validates every reply destination and mention within the bound project space.

Both directions validate bounded NDJSON frames. Tool cancellation carries a request ID and aborts that daemon request. Detach aborts the attachment's requests and frontend work. Long transcription cannot block control messages or reverse RPC replies. Large tool transcripts use a private local file rather than an oversized frame.

## Telegram ownership

The daemon holds a per-bot OS lock before polling or registering commands. Token rotation does not create a second identity. This is a local lock, not a distributed lease: HTTP 409 from another machine stops polling. The daemon refuses configured webhooks.

`telegram/schemas.ts` validates Telegram wire values. `api.ts` handles HTTP, timeouts, and redacted failures; `client.ts` handles media, safe retries and conversation-bound destination/cancellation guards using the real transport. `telegram/frontend.ts` owns Telegram dispatch, authorization, conversation/session composition and outbox delivery. It maps unthreaded input to the bound space's default conversation, and tracked replies to their exact sessions. `telegram/threads.ts` implements project-space-scoped explicit conversation operations and reply anchors. A tracked reply continues its conversation even when the bot is mentioned again. Only explicitly bound chats/topics are active. `/new` creates another conversation; command scoping is separate from ordinary routing.

Uncertain message-creation outcomes are not automatically resent. Explicit rate-limit rejections can retry. The durable reply outbox becomes non-retryable before publication, so a crash or failed local result commit cannot automatically duplicate that reply. A crash before publication can instead leave an acknowledgement missing; explicit user sends and legacy DM streaming use their separate frontend queues.

## Input lifecycle

A per-conversation generation-fenced input FIFO orders user and peer reservations through startup; the Telegram frontend then reserves positions before downloads, transcription, or album debounce. Prepared prompts leave in FIFO order. Controls and picker callbacks use a separate lane, so stop remains available during preparation. Both native and visible Pi hosts use the same delivery controller; `/stop` cancels queued preparation and authentication even while Pi is idle, fences late completions, and still allows fresh input.

Pi submits prepared prompts as SDK custom messages with opaque turn IDs in validated details. This bypasses input-hook text transformations. Before submission, asynchronous preflight checks model/auth availability and attachment identity. `message_start` acknowledges the matching ID; preflight failure or settlement without acknowledgement reports a delivery error and releases the FIFO without blindly retrying. The SDK send is fire-and-forget, not an acknowledgement. During streaming, input uses steering. During compaction or other non-streaming busy states, input waits; outcome hooks schedule delivery after Pi clears its busy state.

Acknowledgement sends the opaque turn ID back to the daemon for preparation accounting and typing. Chat/topic scope is fixed. Explicit text tools choose a validated message target; ordinary assistant output is private. Turn-time uploads capture the current input's anchor; uploads outside a bot turn have no stale anchor. Legacy owner-DM streaming retains captured turn attribution. Detach clears queued prompts and route mappings, and visible task detach stops its writer before handoff; legacy DM input may settle locally without publishing through a later attachment. Unrelated terminal or extension input ends the bot's reply attribution before subsequent assistant output. Neither inbox is crash-durable.

Successful connection intent retains the selected route and owner in validated Pi process memory. DM intent follows `/new`, `/resume`, `/fork`, and `/reload`. A saved group session can reconnect after reload, but another session cannot silently replace its durable association. The owner explicitly releases a group conversation before attaching a replacement. Handoff waits for in-flight Pi mutations and acknowledged daemon release. Explicit disconnect, quit, attachment failure, or unexpected socket closure clears intent; no reconnect loop runs.

## Output lifecycle

Managed/task agents publish only through explicit communication tools. Their ordinary text, thinking and tool output remains in native history. Finishing a turn changes status without sending an automatic completion summary. Explicit outgoing text is saved as targeted native tool details so authorized peers can peek it without exposing arbitrary tool data. The daemon chunks explicit replies and maps sent IDs to the authoring conversation. `telegram/preview.ts` remains for legacy owner-DM streaming, coalescing text into stable messages and throttled edits.

The daemon starts typing after a turn acknowledgement and stops at settlement or detach. Settlement does not rebuild or resend final text. Polling, agent execution, and Telegram delivery remain separate lifecycles.

Whisper execution is shared through the runtime-neutral `audio-transcription/whisper.ts` helper. The portable bridge client owns registration/capture of the active transcription backend; no audio-extension module owns another feature's attachment state. One shared audio tool delegates to that captured backend when attached and uses local execution when detached. Registration happens against Pi's live tool inventory, after session handoff completes.
