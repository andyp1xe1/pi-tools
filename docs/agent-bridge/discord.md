# Discord adapter building blocks

**Status: tested adapter code, not a runnable Discord daemon.** There is no Discord CLI/configuration selection or live Gateway connection yet. Do not put a Discord token in `TELEGRAM_BOT_TOKEN`. Nothing here creates a second thread runtime or changes live bindings.

## Shared service boundary

`src/agent-bridge/discord/` contains:

- `schemas.ts`: validated Discord wire objects; snowflakes are decimal strings, never numbers.
- `normalize.ts`: human text/command syntax, ordinary channel and DM containers, strict reply/native-thread targets, explicit local owner permissions.
- `adapter.ts`: `MESSAGE_CREATE` ingress into an injected `DiscordCorePort`. The shared service supplies command semantics, routing, saved sessions, ownership and input FIFO. No edits or bot/webhook messages become new input.
- `frontend.ts`: a `BridgeFrontend` wrapper using the existing `BotRuntime`, `ThreadOperations`, `BotCommandService` and `executeSessionControl`. It implements ordinary channel/DM binding and admission, explicit user envelopes, terminal anchor publication and scoped session frontends—without another managed startup/queue lifecycle.
- `api.ts`: small official v10 REST client using `Authorization: Bot <token>` and native fetch. It never accepts an arbitrary remote URL. Authentication tokens are not included in errors.
- `transport.ts`: anchor publication, anchored chunked replies and bounded multipart file uploads. `reply(task, targetMessageId, text, mentions, signal, sent)` matches the shared runtime transport method. The `sent` callback runs for **each** acknowledged chunk, even before a later chunk fails. A fallback scope callback also supports attachments and standalone transport tests.
- `session.ts`: structural `ThreadSession` (`SessionFrontend`, `isLive`, `isRunning`, `receivePrepared`). It forwards prompts through `AgentPort`; assistant output stays private. Explicit `reply_message` is the publication path. Session creation/cancellation/writer leases remain in the common bot runtime.
- `gateway.ts`: JSON Gateway v10 protocol state and actions. It implements Identify/Resume, sequence tracking, heartbeat jitter/ACK checks, invalid-session handling and fatal close codes. It deliberately does not own sockets, timers, tokens on disk or Pi sessions.

`DiscordFrontend` supplies `DiscordCorePort.accept`, `knownTarget`, REST channel metadata and scoped transport callbacks for ordinary channels/DMs. Construct it with the existing Store/SessionBackend, a `DiscordREST`, validated bot identity and explicit owner IDs; call `connect(server)` and forward Gateway dispatches through `receive(name, data, signal)`. The host still owns Gateway sockets/timers and configuration. Custom adapter integrations may instead implement the injected `DiscordCorePort` directly. The shared core must recheck project binding and writer generation at admission and before publishing; ingress target prechecks are not a replacement for this. `current(task)` must capture a generation/identity, not merely check that a project is still bound. `resolve(task, targetMessageId?)` must resolve persisted wire routes and refuse unknown targets. Do not infer channel IDs from message IDs.

## Project spaces and routing

Guild text/announcement channels use:

```text
{ platform: "discord", spaceId: <guild ID>, channelId: <channel ID> }
```

DM channels use:

```text
{ platform: "discord", spaceId: "dm:<channel ID>", channelId: <channel ID> }
```

A DM is an ordinary project space. There is no special owner-DM attachment route. Unbound spaces remain inactive. Binding a host directory and controlling a session require explicit configured user-ID authority; Discord administrator roles alone do not grant local filesystem authority. All project/thread tools are the common list/peek/create/message/stop/reply operations.

User-visible space selectors use the shared `projectSpaceKey(container)`, formatted `discord/<encoded-space-ID>/<encoded-channel-ID>`, not the private JSON database key.

Plain text, including an optional bot mention, targets Main. A native Discord reply targets only its exact mapped conversation. Missing or unknown explicit targets fail closed, rather than falling back to Main. Cross-channel/guild replies are refused. `/new` and other textual `/commands` are parsed by the common command service; this adapter does not install Discord slash commands. Discord session controls are textual: `/model` lists models, `/model provider/model` selects one, and `/thinking [level]`, `/status`, `/compact`, `/stop` use the common authorization and exact-target logic.

`publishAnchor` creates a regular bot message so shared threads have replyable anchors. Published reply IDs must be mapped back to their exact shared thread. A native Discord thread is a different wire channel, **not** a message ID. Its ingress requires an existing trusted alias to a shared root message, scoped to the parent channel's project space. Persisting native-thread/channel metadata and provisioning native threads are not implemented. `DiscordFrontend` refuses all native-thread ingress; the lower-level injected adapter supports existing trusted aliases when another host supplies them. Unknown native threads and unsupported forum/media/group-DM channels fail closed. Textless attachments and incoming voice/media preprocessing are not implemented.

## Discord application requirements

For eventual integration:

1. Create a bot application and store its bot token privately outside this checkout. No user-account tokens or credentials belong in agent prompts.
2. Install with the OAuth2 `bot` scope into the intended guild. Request only needed channel permissions: View Channel, Send Messages and Read Message History for anchored replies; Attach Files for uploads. Native-thread publishing additionally needs Send Messages in Threads and access to the thread. No Administrator permission is needed. Creating native threads would need separate permissions and is not implemented here.
3. Enable Message Content Intent in the Developer Portal (and obtain approval if required). The adapter's intent mask includes GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES and MESSAGE_CONTENT. Without content access, ordinary guild text cannot implement the Main-input contract. DM/mention exceptions do not provide complete guild-message visibility.
4. Fetch `/users/@me` and `/gateway/bot` using the same REST client. A host must enforce session-start limits, single-shard eligibility, reconnect backoff and Identify concurrency. The protocol helper alone does not enforce those limits.
5. Connect to the validated Gateway URL using native WebSocket, JSON v10, no compression. Apply `send` actions; schedule `heartbeat-timer` actions; cancel obsolete timers on disconnect; use `opened()` for each new socket; handle reconnect/fatal actions. Serialize dispatch admission, isolate stale socket callbacks and do not log Identify/Resume payloads (they contain the token). The Gateway replay stream is not a crash-durable inbox; use the shared message-ID deduplication.
6. Forward `MESSAGE_CREATE` dispatches through `DiscordAdapter`. Ignore unrelated events for agent input. Cache/invalidate channel metadata correctly if adding a cache. Use persisted message/thread mappings for explicit targeting.

## Delivery and authorization

Replies include `message_reference` with `fail_if_not_exists: true`. Deleted anchors fail rather than leaking into an unthreaded channel. Every chunk retains its anchor and is at most 2,000 UTF-16 code units without splitting surrogate pairs. Formatting is ordinary Discord text, not Telegram HTML. Automatic user, role and everyone mentions are disabled; only explicit known user IDs are enabled and visibly prefixed to the content. Reply-author pings stay disabled.

Creation requests use a unique nonce (within Discord's 25-character limit) and `enforce_nonce`. This protects against near-term duplicate nonce creation, **not** permanent idempotency. REST serializes outgoing requests conservatively and observes server rate-limit deadlines. Each HTTP attempt has a 30-second abort deadline; waits remain caller-abortable. A definitive 401 disables further credential use in that client until configuration is corrected and a new client is constructed. Only a definitive 429 rejection is retried, at most twice, using `retry_after`. Network failures, server errors and malformed success responses on sends are uncertain outcomes and are never automatically retried. Hosts must also treat `DiscordDeliveryUnknown` as nonretryable; a generic durable reply queue must not blindly resend it. Rate-limit bucket discovery/global pacing for larger installations is a remaining integration concern.

File uploads use `files[0]`, `payload_json` and attachment metadata; no token is sent to a CDN. The default upload cap is a conservative configurable 10 MiB, not a guarantee that every channel permits that size. File sends require an acknowledged platform reply anchor and fail closed while a terminal's first anchor is still pending. They are explicit, locally authorized operations; the adapter is not a filesystem sandbox. REST typing is available, but this session does not run a background typing/streaming loop.

## Webhooks and interactions

There is **no public HTTP endpoint** in this implementation. Discord incoming channel webhooks cannot receive ordinary messages and are not a replacement for Gateway ingress. Receiving interactions over Gateway and receiving interactions through an HTTP Interactions Endpoint are mutually exclusive modes. Future HTTP interactions must verify Ed25519 signatures over timestamp plus raw request body, reject invalid signatures, acknowledge PING, and meet the initial response deadline. Even Gateway interactions require REST callback responses, not Gateway sends. Slash commands, interaction callbacks, menus and webhook signature handling are intentionally not implemented.

## Tests

```sh
bun test tests/agent-bridge/discord.test.ts
```

Tests use fake REST/Gateway data and an in-memory shared Store/Router. They cover channel/DM routing, explicit-target isolation, permission policy, bot/webhook filtering, real shared routing and command/runtime delegation, ordinary DM bind/unbind/history retention, reply chunk anchors/mentions, partial-send mapping, uploads, uncertain-outcome handling, session privacy and Gateway Identify/Resume/heartbeat/fatal behavior. No token, network access, live binding or daemon restart is needed.

## Official references

- [API reference and bot authentication](https://docs.discord.com/developers/reference)
- [OAuth2 bot authorization](https://docs.discord.com/developers/topics/oauth2)
- [Gateway lifecycle and intents](https://docs.discord.com/developers/events/gateway)
- [Gateway events](https://docs.discord.com/developers/events/gateway-events)
- [Gateway close codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes)
- [Message resource: replies, mentions, nonces and uploads](https://docs.discord.com/developers/resources/message)
- [REST rate limits](https://docs.discord.com/developers/topics/rate-limits)
- [Channel and native-thread operations](https://docs.discord.com/developers/resources/channel)
- [Interactions and webhook authentication](https://docs.discord.com/developers/interactions/overview)
- [Receiving/responding to interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
