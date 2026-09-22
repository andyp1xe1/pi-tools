import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { transcribeWithWhisper } from "../audio-transcription/whisper.ts";

const WHISPER_MODEL = process.env.PI_TELEGRAM_WHISPER_MODEL?.trim() || process.env.PI_WHISPER_MODEL?.trim() || "base";
const WHISPER_LANGUAGE = process.env.PI_TELEGRAM_WHISPER_LANGUAGE?.trim() || process.env.PI_WHISPER_LANGUAGE?.trim();

export interface VoiceTranscriptionResult {
  text?: string;
  error?: string;
}

export async function transcribeTelegramVoice(
  pi: ExtensionAPI,
  filePath: string,
  tempDir: string,
): Promise<VoiceTranscriptionResult> {
  try {
    const text = await transcribeWithWhisper(pi, filePath, {
      model: WHISPER_MODEL,
      language: WHISPER_LANGUAGE,
      timeoutMs: 5 * 60 * 1000,
      tempRoot: tempDir,
    });
    return { text };
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(-1000) : String(error).slice(-1000) };
  }
}
