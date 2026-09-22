import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findExecutable, transcribeWithWhisper } from "../src/audio-transcription/whisper.ts";

const DEFAULT_MODEL = process.env.PI_WHISPER_MODEL?.trim() || "base";
const DEFAULT_LANGUAGE = process.env.PI_WHISPER_LANGUAGE?.trim();

function normalizePath(input: string, cwd: string): string {
  const withoutMentionPrefix = input.startsWith("@") ? input.slice(1) : input;
  return resolve(cwd, withoutMentionPrefix);
}

export default async function audioTranscription(pi: ExtensionAPI) {
  const whisper = await findExecutable("whisper");
  if (!whisper) return;

  pi.registerTool({
    name: "transcribe_audio",
    label: "Transcribe Audio",
    description: `Transcribe a local audio file with Whisper. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the complete transcript is retained in a temporary file when truncated.`,
    promptSnippet: "Transcribe speech from a local audio file with Whisper.",
    promptGuidelines: [
      "Use transcribe_audio to inspect speech in local audio files and audio attachments; do not try to read audio as text.",
      "Do not use transcribe_audio for Telegram voice messages that already include a local transcript unless the user asks for retranscription.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the local audio file." }),
      model: Type.Optional(Type.String({ description: `Whisper model name. Defaults to ${DEFAULT_MODEL}.` })),
      language: Type.Optional(
        Type.String({ description: "Spoken language code, such as en. Omit to detect the language automatically." }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const audioPath = normalizePath(params.path, ctx.cwd);
      const file = await stat(audioPath);
      if (!file.isFile()) throw new Error(`Not a file: ${audioPath}`);

      const model = params.model?.trim() || DEFAULT_MODEL;
      const language = params.language?.trim() || DEFAULT_LANGUAGE;
      onUpdate?.({
        content: [{ type: "text", text: `Transcribing ${audioPath} with Whisper ${model}...` }],
        details: { path: audioPath, model, language },
      });

      const transcript = await transcribeWithWhisper(pi, audioPath, {
        executable: whisper,
        model,
        language,
        signal,
      });
      const truncation = truncateHead(transcript, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let text = truncation.content;
      let fullOutputPath: string | undefined;

      if (truncation.truncated) {
        const outputDir = await mkdtemp(join(tmpdir(), "pi-transcript-"));
        fullOutputPath = join(outputDir, `${Date.now()}-transcript.txt`);
        await writeFile(fullOutputPath, transcript, "utf8");
        text += `\n\n[Transcript truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
        text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
        text += ` Full transcript saved to: ${fullOutputPath}]`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          path: audioPath,
          model,
          language,
          fullOutputPath,
          truncation: truncation.truncated ? truncation : undefined,
        },
      };
    },
  });
}
