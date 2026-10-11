import * as v from "valibot";

export const PositiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const safeInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(-Number.MAX_SAFE_INTEGER),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
export const UserSchema = v.object({
  id: PositiveInteger,
  is_bot: v.optional(v.boolean(), false),
  first_name: v.optional(v.string(), ""),
  username: v.optional(v.string()),
});
const file = {
  file_id: v.pipe(v.string(), v.nonEmpty()),
  file_size: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
};
const media = v.object({ ...file, file_name: v.optional(v.string()), mime_type: v.optional(v.string()) });
const MessageBaseSchema = v.object({
  message_id: PositiveInteger,
  chat: v.object({ id: safeInteger, type: v.string(), is_forum: v.optional(v.boolean()) }),
  from: v.optional(UserSchema),
  sender_chat: v.optional(v.unknown()),
  message_thread_id: v.optional(PositiveInteger),
  is_topic_message: v.optional(v.boolean()),
  text: v.optional(v.string()),
  caption: v.optional(v.string()),
  entities: v.optional(
    v.array(
      v.object({
        type: v.string(),
        offset: v.pipe(safeInteger, v.minValue(0)),
        length: PositiveInteger,
        user: v.optional(UserSchema),
      }),
    ),
  ),
  caption_entities: v.optional(
    v.array(
      v.object({
        type: v.string(),
        offset: v.pipe(safeInteger, v.minValue(0)),
        length: PositiveInteger,
        user: v.optional(UserSchema),
      }),
    ),
  ),
  forum_topic_created: v.optional(v.unknown()),
  media_group_id: v.optional(v.string()),
  photo: v.optional(v.array(v.object(file))),
  document: v.optional(media),
  video: v.optional(media),
  audio: v.optional(media),
  voice: v.optional(media),
  animation: v.optional(media),
  sticker: v.optional(
    v.object({
      ...file,
      emoji: v.optional(v.string()),
      is_animated: v.optional(v.boolean(), false),
      is_video: v.optional(v.boolean(), false),
    }),
  ),
});
export const TelegramMessageSchema = v.object({
  ...MessageBaseSchema.entries,
  reply_to_message: v.optional(MessageBaseSchema),
});
export const TelegramUpdateSchema = v.object({
  update_id: v.pipe(safeInteger, v.minValue(0)),
  message: v.optional(TelegramMessageSchema),
  edited_message: v.optional(TelegramMessageSchema),
  callback_query: v.optional(
    v.object({
      id: v.string(),
      from: UserSchema,
      message: v.optional(TelegramMessageSchema),
      data: v.optional(v.string()),
    }),
  ),
});
export type TelegramMessage = v.InferOutput<typeof TelegramMessageSchema>;
export type TelegramUpdate = v.InferOutput<typeof TelegramUpdateSchema>;
export type TelegramCallbackQuery = NonNullable<TelegramUpdate["callback_query"]>;
export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}
export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}
export const BotSchema = v.object({
  id: PositiveInteger,
  username: v.pipe(v.string(), v.nonEmpty()),
  can_read_all_group_messages: v.optional(v.boolean()),
});
export type BotIdentity = Pick<v.InferOutput<typeof BotSchema>, "id" | "username">;
export const WebhookSchema = v.object({ url: v.string() });
const SentMessageSchema = v.object({ message_id: PositiveInteger });
export const TelegramResultSchemas = {
  getMe: BotSchema,
  getWebhookInfo: WebhookSchema,
  getUpdates: v.array(TelegramUpdateSchema),
  sendMessage: SentMessageSchema,
  editMessageText: v.union([SentMessageSchema, v.literal(true)]),
  sendChatAction: v.boolean(),
  answerCallbackQuery: v.boolean(),
  setMyCommands: v.boolean(),
  getFile: v.object({ file_path: v.pipe(v.string(), v.nonEmpty()) }),
  sendPhoto: SentMessageSchema,
  sendDocument: SentMessageSchema,
};
export type TelegramMethod = keyof typeof TelegramResultSchemas;
