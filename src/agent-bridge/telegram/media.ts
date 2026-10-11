import { extname } from "node:path";
import type { TelegramMessage } from "./schemas.ts";

export interface TelegramFileInfo {
  file_id: string;
  fileName: string;
  mimeType?: string;
  isImage: boolean;
  isVoice: boolean;
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
  if (!mimeType) return fallback;
  const extensions: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  };
  return extensions[mimeType.toLowerCase()] ?? fallback;
}

export function guessImageMediaType(path: string): string | undefined {
  const mediaTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  return mediaTypes[extname(path).toLowerCase()];
}

function isImageMimeType(mimeType: string | undefined): boolean {
  return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

export function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
  const files: TelegramFileInfo[] = [];
  for (const message of messages) {
    if (message.photo?.length) {
      const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
      if (photo) {
        files.push({
          file_id: photo.file_id,
          fileName: `photo-${message.message_id}.jpg`,
          mimeType: "image/jpeg",
          isImage: true,
          isVoice: false,
        });
      }
    }
    // Each category is independent, including Telegram's document/animation aliases.
    for (const [kind, fallback] of [
      ["document", ""],
      ["video", ".mp4"],
      ["audio", ".mp3"],
      ["voice", ".ogg"],
      ["animation", ".mp4"],
    ] as const) {
      const media = message[kind];
      if (!media) continue;
      const generatedName = `${kind}-${message.message_id}${guessExtensionFromMime(media.mime_type, fallback)}`;
      files.push({
        file_id: media.file_id,
        fileName: kind === "voice" ? generatedName : media.file_name || generatedName,
        mimeType: media.mime_type,
        isImage: kind === "document" && isImageMimeType(media.mime_type),
        isVoice: kind === "voice",
      });
    }
    if (message.sticker) {
      const animated = message.sticker.is_animated;
      const video = message.sticker.is_video;
      files.push({
        file_id: message.sticker.file_id,
        fileName: `sticker-${message.message_id}${animated ? ".tgs" : video ? ".webm" : ".webp"}`,
        mimeType: animated ? "application/x-tgsticker" : video ? "video/webm" : "image/webp",
        isImage: !animated && !video,
        isVoice: false,
      });
    }
  }
  return files;
}
