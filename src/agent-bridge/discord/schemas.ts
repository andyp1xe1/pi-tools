import * as v from "valibot";

/** Snowflakes remain decimal strings; Number loses precision for Discord IDs. */
export const SnowflakeSchema = v.pipe(v.string(), v.regex(/^[1-9]\d{0,19}$/));
export const DiscordUserSchema = v.object({
  id: SnowflakeSchema,
  username: v.string(),
  global_name: v.optional(v.nullable(v.string())),
  bot: v.optional(v.boolean()),
});
export const DiscordMessageSchema = v.object({
  id: SnowflakeSchema,
  channel_id: SnowflakeSchema,
  guild_id: v.optional(SnowflakeSchema),
  author: DiscordUserSchema,
  content: v.string(),
  type: v.pipe(v.number(), v.integer()),
  webhook_id: v.optional(SnowflakeSchema),
  message_reference: v.optional(
    v.object({
      type: v.optional(v.pipe(v.number(), v.integer())),
      message_id: v.optional(SnowflakeSchema),
      channel_id: v.optional(SnowflakeSchema),
      guild_id: v.optional(SnowflakeSchema),
    }),
  ),
});
export const DiscordChannelSchema = v.object({
  id: SnowflakeSchema,
  type: v.pipe(v.number(), v.integer()),
  guild_id: v.optional(SnowflakeSchema),
  parent_id: v.optional(v.nullable(SnowflakeSchema)),
});
export const GatewayBotSchema = v.object({
  url: v.pipe(v.string(), v.url()),
  shards: v.pipe(v.number(), v.integer(), v.minValue(1)),
  session_start_limit: v.object({
    total: v.number(),
    remaining: v.number(),
    reset_after: v.number(),
    max_concurrency: v.number(),
  }),
});
export const GatewayFrameSchema = v.object({
  op: v.pipe(v.number(), v.integer()),
  d: v.unknown(),
  s: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
  t: v.optional(v.nullable(v.string())),
});
export type DiscordMessage = v.InferOutput<typeof DiscordMessageSchema>;
export type DiscordChannel = v.InferOutput<typeof DiscordChannelSchema>;
export type GatewayFrame = v.InferOutput<typeof GatewayFrameSchema>;
