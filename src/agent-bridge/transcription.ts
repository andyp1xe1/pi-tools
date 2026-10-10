import { execFile } from "node:child_process";
import { transcribeWithWhisper } from "../audio-transcription/whisper.ts";

export class TranscriptionError extends Error {
  constructor(error: unknown) {
    super(
      (error instanceof Error ? error.message : typeof error === "string" ? error : "Transcription failed")
        .slice(-1500)
        .replace(/\b[1-9]\d{5,}:[a-zA-Z0-9_-]{20,}\b/g, "[redacted bot token]"),
    );
  }
}
let active = 0;
export async function transcribeAudio(
  path: string,
  options: { model?: string; language?: string; signal?: AbortSignal } = {},
): Promise<string> {
  if (active >= 2) throw new TranscriptionError("Transcription is busy. Try again later.");
  active++;
  try {
    return await transcribeWithWhisper(
      {
        exec(command, args, settings) {
          return new Promise((resolve, reject) => {
            execFile(
              command,
              args,
              { signal: settings.signal, timeout: settings.timeout, maxBuffer: 4 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && typeof error.code !== "number") {
                  reject(error);
                  return;
                }
                resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
              },
            );
          });
        },
      },
      path,
      {
        ...options,
        model: options.model ?? process.env.AGENT_BRIDGE_WHISPER_MODEL ?? process.env.PI_WHISPER_MODEL,
        language: options.language ?? process.env.AGENT_BRIDGE_WHISPER_LANGUAGE ?? process.env.PI_WHISPER_LANGUAGE,
        timeoutMs: 5 * 60 * 1000,
      },
    );
  } catch (error) {
    throw new TranscriptionError(error);
  } finally {
    active--;
  }
}
