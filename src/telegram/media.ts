import { extname } from "node:path";
import type { TelegramFileInfo, TelegramMessage } from "./types.ts";

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
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
    if (message.document) {
      files.push({
        file_id: message.document.file_id,
        fileName:
          message.document.file_name ||
          `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`,
        mimeType: message.document.mime_type,
        isImage: isImageMimeType(message.document.mime_type),
        isVoice: false,
      });
    }
    if (message.video) {
      files.push({
        file_id: message.video.file_id,
        fileName:
          message.video.file_name ||
          `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`,
        mimeType: message.video.mime_type,
        isImage: false,
        isVoice: false,
      });
    }
    if (message.audio) {
      files.push({
        file_id: message.audio.file_id,
        fileName:
          message.audio.file_name ||
          `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`,
        mimeType: message.audio.mime_type,
        isImage: false,
        isVoice: false,
      });
    }
    if (message.voice) {
      files.push({
        file_id: message.voice.file_id,
        fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
        mimeType: message.voice.mime_type,
        isImage: false,
        isVoice: true,
      });
    }
    if (message.animation) {
      files.push({
        file_id: message.animation.file_id,
        fileName:
          message.animation.file_name ||
          `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`,
        mimeType: message.animation.mime_type,
        isImage: false,
        isVoice: false,
      });
    }
    if (message.sticker) {
      files.push({
        file_id: message.sticker.file_id,
        fileName: `sticker-${message.message_id}.webp`,
        mimeType: "image/webp",
        isImage: true,
        isVoice: false,
      });
    }
  }
  return files;
}
