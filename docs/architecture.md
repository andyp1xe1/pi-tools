# Code boundaries

Extension entrypoints under `extensions/` call named registration functions. Implementations live under `src/`; importing them does not register an extension.

## One project-thread system

```text
src/agent-bridge/
  daemon.ts          Telegram poller and CLI lifecycle/composition
  server.ts          portable private IPC, writer ownership, cancellation, reverse RPC
  frontend.ts        injected backend, frontend and capability interfaces
  protocol.ts        runtime-neutral validated IPC contracts
  client.ts          portable IPC and active transcription-provider registration
  config.ts          private environment, data-path preparation and daemon config
  store.ts           project/thread/session associations and durable reply outbox
  telegram/          Telegram wire normalization, HTTP/media, menus and delivery
  discord/           Discord wire adapter, REST, Gateway state helper and thread transport

src/bot/            shared bot services (no Pi SDK dependency):
  runtime.ts          saved-thread registration, single-flight startup, FIFO and cancellation
  commands.ts         project command parsing, directory binding and help
  command-service.ts  shared admission, Main/reply targeting, commands and session controls
  thread-operations.ts scoped list/peek/create/message/stop/reply operations

src/bot/            Pi-specific integration:
  index.ts            extension registration
  session-adapter.ts  terminal saved-thread registration and clean writer handoff
  delivery.ts         preparation, preflight, acknowledgement and cancellation
  controls.ts         reverse-RPC validation, model selection and busy policy
  inbox.ts            ordered custom-message submission and acknowledgement
  messages.ts         prepared local files to Pi content; history text projection
  status.ts           Pi model/thinking/usage/context snapshots
  tools.ts            file-send tool wrapper around IPC
  thread-tools.ts     explicit communication tools and bounded native-history projection

src/pi-backend/
  index.ts            native saved SDK sessions with parallel tools and normal resources
```

The daemon injects a native backend and a platform frontend. Telegram and Discord frontends compose the same `BotRuntime`, `BotCommandService` and `ThreadOperations`; they do not implement separate saved-thread lifecycles. Platform-local transports own wire destinations, safe mentions, anchors, chunking and acknowledged message mappings. `telegram/threads.ts` and `agent-bridge/control.ts` are compatibility reexports of shared services, not duplicate implementations.

Runtime-neutral service modules do not import Pi SDKs. The terminal extension's runtime graph reaches bridge infrastructure only through portable `client.ts`/`protocol.ts`; it never loads SQLite, daemon composition, shared daemon services or platform HTTP helpers. Boundary tests check both these graphs. The IPC server receives an injected frontend rather than importing Telegram or SQLite.

The shipped daemon runs Telegram. The Discord adapter and Gateway state helper are offline-tested, but production socket/timer/config orchestration, native-thread wire aliases and inbound media are still host-integration work; see [Discord status](agent-bridge/discord.md).

## Spaces, Main, and siblings

DMs, groups and topics bind to ordinary directories, including `~`. Each project-space binding has its own saved Main. Plain input and controls select Main; tracked replies select their exact saved thread. Unknown explicit targets fail closed. `/new` and `create_thread` create siblings without replacing Main. There is no sticky worker selection or special owner-DM route.

Saved terminal sessions register as siblings when their canonical cwd uniquely matches a bound space. `/bot [platform/space/channel] [owner ID]` reports status or resolves ambiguity. Public attachment/release commands are absent. The internal IPC connection is a single-writer lease for an exact route, saved session ID/file, cwd and owner. Session/file reuse across routes is refused. A clean terminal exit allows managed continuation; unconfirmed terminal loss blocks revival until that exact writer reconnects and stops cleanly.

Thread scope is the originating project space, not shared cwd. A worker may choose another existing directory, including an agent-created worktree, without gaining communication access to another space. Owners authorize local binding and session controls; they are not routing keys. Independent threads may belong to one owner.

Startup is single-flight per thread, not serialized by project. Opaque startup tokens and lifecycle generations fence late input/registration after stop/unbind. There are no subprocess workers, session caps, filesystem isolation or automatic worktrees. Agents explicitly coordinate shared-resource changes.

## IPC and private output

The daemon sends opaque turn IDs, prepared text and absolute image-file paths. Pi reads images locally; raw wire updates and model credentials never travel through the bridge.

Reverse RPC exposes bounded session snapshots/history, validated model/thinking selection, abort and compaction. Saved threads refuse destructive session-reset RPC. Telegram renders menus; Discord uses textual controls backed by the same capabilities.

Pi sends acknowledgement, delivery-error, busy and settled events. Ordinary assistant text, thinking and tool results remain private for both managed and terminal threads. Explicit operations publish user replies, peer input, files or thread anchors; they cannot invoke arbitrary platform API methods. Minimal input envelopes identify author, peer and replyable message IDs without exposing credentials or raw platform payloads.

Both directions validate bounded NDJSON. A tool cancellation ID aborts its exact daemon request. Writer disconnection aborts its outstanding requests and frontend work. Long transcription cannot block controls; oversized transcript output uses a private local file reference. Shared error wrapping preserves `unknownOutcome`, preventing unsafe retries across the transport/IPC boundary.

## Input and writer lifecycle

A generation-fenced per-thread FIFO orders user and peer reservations through startup. Platform sessions reserve positions before slow media preparation. Controls use a separate lane. `/stop` fences the runtime FIFO even for a live writer, cancels prepared/auth/media/album work and aborts native queues. Late completion cannot deliver stopped input; later fresh input can proceed.

Pi submits SDK custom messages with validated opaque turn IDs. Async preflight checks model/auth and writer identity. Matching `message_start` acknowledges receipt; failure or settlement without acknowledgement reports once and releases the FIFO instead of retrying uncertain work. Steering is used during active runs; compaction/busy states delay delivery until idle. Recorded input is not crash-replayed.

Handoff invalidates stale tools/provider captures and waits for native abort, queue clearing, full settlement and started model/compaction mutations before confirming release. A failed handoff remains a closed barrier. Reload may restore only the same saved identity; new/resumed/forked sessions do not inherit the previous thread. Unrelated terminal input ends bot-turn attribution without changing project membership.

## Delivery ownership

Telegram holds a per-bot OS lock before polling; configured webhooks, authentication failures and cross-machine polling conflicts fail safely. Platform schemas validate wire values. HTTP/media helpers own redacted errors, deadlines, cancellations and safe retry classification.

Explicit replies map every acknowledged outgoing chunk, including successful prefixes of a later failed send. Current-writer checks fence stale publication/mappings after cancellation. Terminal anchor claims are persisted before network publication, so reconnect cannot automatically duplicate a possibly delivered anchor.

The durable operational-reply outbox becomes non-retryable before sending. Only a definitively safe rejection can requeue it; uncertain sends or local commit failure do not. A crash before sending can leave an acknowledgement missing, intentionally preferred to duplication. Telegram can recover an ambiguous send's task mapping only from this bot's stored, uniquely identifying acknowledgement text.

Turn completion changes status but does not publish a summary or notify a parent. Workers explicitly `message_thread` their requester. User publication requires `reply_message` or `bot_attach`. Authorized bounded peeks include ordinary history and explicit-send details, but omit thinking, raw tool results and arguments.

Whisper execution uses the neutral `audio-transcription/whisper.ts` helper. The portable client owns active transcription-provider capture. The audio extension delegates to a captured provider when registered and uses local execution otherwise; daemon failures never trigger local fallback. Tool registration waits for session handoff and respects the existing live tool inventory.
