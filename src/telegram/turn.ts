import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TelegramClient } from "./client.ts";
import { TELEGRAM_PREFIX, TEMP_DIR } from "./constants.ts";
import { collectTelegramFileInfos, guessImageMediaType } from "./media.ts";
import type { DownloadedTelegramFile, PendingTelegramTurn, TelegramMessage } from "./types.ts";
import { transcribeTelegramVoice } from "./voice-transcription.ts";

async function downloadTelegramFiles(
  client: TelegramClient,
  messages: TelegramMessage[],
): Promise<DownloadedTelegramFile[]> {
  const downloaded: DownloadedTelegramFile[] = [];
  for (const file of collectTelegramFileInfos(messages)) {
    downloaded.push({
      path: await client.downloadFile(file.file_id, file.fileName),
      fileName: file.fileName,
      isImage: file.isImage,
      isVoice: file.isVoice,
      mimeType: file.mimeType,
    });
  }
  return downloaded;
}

export async function createTelegramTurn(
  pi: ExtensionAPI,
  client: TelegramClient,
  messages: TelegramMessage[],
): Promise<PendingTelegramTurn> {
  const firstMessage = messages[0];
  if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
  const rawText = messages
    .map((message) => (message.text || message.caption || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const files = await downloadTelegramFiles(client, messages);
  let prompt = rawText ? `${TELEGRAM_PREFIX} ${rawText}` : TELEGRAM_PREFIX;

  for (const file of files) {
    if (!file.isVoice) continue;
    const transcript = await transcribeTelegramVoice(pi, file.path, TEMP_DIR);
    prompt += transcript.text
      ? `\n\nLocal transcript of ${file.fileName}:\n${transcript.text}`
      : `\n\nLocal transcription of ${file.fileName} failed: ${transcript.error ?? "unknown error"}`;
  }

  if (files.length) {
    prompt += "\n\nTelegram attachments were saved locally:";
    for (const file of files) prompt += `\n- ${file.path}`;
  }

  const content: PendingTelegramTurn["content"] = [{ type: "text", text: prompt }];
  for (const file of files) {
    if (!file.isImage) continue;
    const mediaType = file.mimeType || guessImageMediaType(file.path);
    if (!mediaType) continue;
    content.push({ type: "image", data: (await readFile(file.path)).toString("base64"), mimeType: mediaType });
  }

  return {
    chatId: firstMessage.chat.id,
    replyToMessageId: firstMessage.message_id,
    queuedAttachments: [],
    content,
  };
}
