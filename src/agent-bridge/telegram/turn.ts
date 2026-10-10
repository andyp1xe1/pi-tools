import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedPrompt } from "../protocol.ts";
import type { TelegramClient } from "./client.ts";
import { TELEGRAM_PREFIX, TEMP_DIR } from "./constants.ts";
import { collectTelegramFileInfos, guessImageMediaType, type TelegramFileInfo } from "./media.ts";
import type { TelegramMessage } from "./schemas.ts";

export interface PendingTelegramTurn {
  chatId: number;
  replyToMessageId: number;
  content: PreparedPrompt["content"];
}
type DownloadedTelegramFile = Omit<TelegramFileInfo, "file_id"> & { path: string };
interface VoiceTranscriptionResult {
  text?: string;
  error?: string;
}

/** The daemon executes Whisper; Pi only consumes the validated RPC transcript. */
async function transcribeTelegramVoice(
  client: TelegramClient,
  filePath: string,
  signal?: AbortSignal,
): Promise<VoiceTranscriptionResult> {
  try {
    const text = await client.transcribeAudio(filePath, undefined, undefined, signal);
    return { text };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    return { error: error instanceof Error ? error.message.slice(-1000) : String(error).slice(-1000) };
  }
}

async function downloadTelegramFiles(
  client: TelegramClient,
  messages: TelegramMessage[],
  signal?: AbortSignal,
): Promise<DownloadedTelegramFile[]> {
  const downloaded: DownloadedTelegramFile[] = [];
  for (const { file_id, ...metadata } of collectTelegramFileInfos(messages)) {
    downloaded.push({ ...metadata, path: await client.downloadFile(file_id, metadata.fileName, signal) });
  }
  return downloaded;
}

export async function createTelegramTurn(
  client: TelegramClient,
  messages: TelegramMessage[],
  signal?: AbortSignal,
): Promise<PendingTelegramTurn> {
  const firstMessage = messages[0];
  if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
  const rawText = messages
    .map((message) => (message.text || message.caption || "").trim())
    .filter(Boolean)
    .join("\n\n");
  signal?.throwIfAborted();
  const files = await downloadTelegramFiles(client, messages, signal);
  let prompt = rawText ? `${TELEGRAM_PREFIX} ${rawText}` : TELEGRAM_PREFIX;

  for (const file of files) {
    if (!file.isVoice) continue;
    const transcript = await transcribeTelegramVoice(client, file.path, signal);
    let text = transcript.text;
    if (text && text.length > 50000) {
      await mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
      const path = join(TEMP_DIR, `${randomUUID()}-voice-transcript.txt`);
      await writeFile(path, text, { mode: 0o600, flag: "wx", signal });
      text = `${text.slice(0, 50000)}\n[Transcript truncated. Full transcript: ${path}]`;
    }
    prompt += text
      ? `\n\nLocal transcript of ${file.fileName}:\n${text}`
      : `\n\nLocal transcription of ${file.fileName} failed: ${transcript.error ?? "unknown error"}`;
  }

  signal?.throwIfAborted();
  if (files.length) {
    prompt += "\n\nTelegram attachments were saved locally:";
    for (const file of files) prompt += `\n- ${file.path}`;
  }

  const content: PendingTelegramTurn["content"] = [{ type: "text", text: prompt }];
  for (const file of files) {
    if (!file.isImage) continue;
    const mediaType = file.mimeType || guessImageMediaType(file.path);
    if (!mediaType) continue;
    content.push({
      type: "image-file",
      path: file.path,
      mimeType: mediaType,
    });
  }

  return {
    chatId: firstMessage.chat.id,
    replyToMessageId: firstMessage.message_id,
    content,
  };
}
