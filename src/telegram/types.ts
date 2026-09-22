import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TelegramConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  lastChatId?: number;
  lastUpdateId?: number;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAnimation {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramSticker {
  file_id: string;
  emoji?: string;
}

export interface TelegramFileInfo {
  file_id: string;
  fileName: string;
  mimeType?: string;
  isImage: boolean;
  isVoice: boolean;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramFileResult {
  file_path: string;
}

export interface TelegramSentMessage {
  message_id: number;
}

export interface DownloadedTelegramFile {
  path: string;
  fileName: string;
  isImage: boolean;
  isVoice: boolean;
  mimeType?: string;
}

export interface QueuedAttachment {
  path: string;
  fileName: string;
}

export interface PendingTelegramTurn {
  chatId: number;
  replyToMessageId: number;
  queuedAttachments: QueuedAttachment[];
  content: Array<TextContent | ImageContent>;
}

export type ActiveTelegramTurn = PendingTelegramTurn;

export interface TelegramMediaGroupState {
  messages: TelegramMessage[];
  flushTimer?: ReturnType<typeof setTimeout>;
}
