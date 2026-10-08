import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureBridgeTranscription } from "../agent-bridge/client.ts";
import { findExecutable, transcribeWithWhisper } from "./whisper.ts";

const DEFAULT_MODEL = process.env.PI_WHISPER_MODEL?.trim() || "base";
const DEFAULT_LANGUAGE = process.env.PI_WHISPER_LANGUAGE?.trim();

function normalizePath(input: string, cwd: string): string {
  const withoutMentionPrefix = input.startsWith("@") ? input.slice(1) : input;
  return resolve(cwd, withoutMentionPrefix);
}

export async function registerAudioTranscription(pi: ExtensionAPI) {
  if (!(await findExecutable("whisper"))) return;
  // getAllTools is only bound after extension loading. Register against the
  // live inventory so either extension load order has exactly one definition.
  pi.on("session_start", () => registerAudioTranscriptionTool(pi));
}

/** Shared ordinary tool, also registered by the bot when local Whisper is absent. */
export function registerAudioTranscriptionTool(pi: ExtensionAPI): void {
  if (pi.getAllTools().some((tool) => tool.name === "transcribe_audio")) return;
  pi.registerTool(createAudioTranscriptionTool(pi));
}

/** A managed host supplies a session-local capture; ordinary extensions keep the registry default. */
export function createAudioTranscriptionTool(
  pi: ExtensionAPI,
  capture: typeof captureBridgeTranscription = captureBridgeTranscription,
) {
  return defineTool({
    name: "transcribe_audio",
    label: "Transcribe Audio",
    description: `Transcribe a local audio file with Whisper (through the daemon when the bot bridge is attached, locally otherwise). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the complete transcript is retained in a temporary file when truncated.`,
    promptSnippet: "Transcribe speech from a local audio file with Whisper.",
    promptGuidelines: [
      "Use transcribe_audio to inspect speech in local audio files and audio attachments; do not try to read audio as text.",
      "Do not use transcribe_audio for Telegram voice messages that already include a local transcript unless the user asks for retranscription.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the local audio file." }),
      model: Type.Optional(
        Type.String({
          description: `Whisper model name. Omit for the daemon default when attached, ${DEFAULT_MODEL} locally.`,
        }),
      ),
      language: Type.Optional(
        Type.String({ description: "Spoken language code, such as en. Omit to detect the language automatically." }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const bridge = capture();
      signal?.throwIfAborted();
      const audioPath = normalizePath(params.path, ctx.cwd);
      const file = await stat(audioPath);
      signal?.throwIfAborted();
      if (!file.isFile()) throw new Error(`Not a file: ${audioPath}`);

      const model = params.model?.trim() || (bridge ? undefined : DEFAULT_MODEL);
      const language = params.language?.trim() || (bridge ? undefined : DEFAULT_LANGUAGE);
      onUpdate?.({
        content: [{ type: "text", text: `Transcribing ${audioPath} with Whisper ${model ?? "(daemon default)"}...` }],
        details: { path: audioPath, model, language },
      });

      // A captured daemon owns this call even if it fails or detaches. Never
      // retry locally, or look up a newer attachment after filesystem awaits.
      const transcript = bridge
        ? await bridge({ path: audioPath, model, language, signal })
        : await transcribeWithWhisper(pi, audioPath, { model, language, signal });
      signal?.throwIfAborted();
      const truncation = truncateHead(transcript, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let text = truncation.content;
      let fullOutputPath: string | undefined;

      if (truncation.truncated) {
        const outputDir = await mkdtemp(join(tmpdir(), "pi-transcript-"));
        fullOutputPath = join(outputDir, "transcript.txt");
        try {
          await writeFile(fullOutputPath, transcript, { encoding: "utf8", mode: 0o600, signal });
          signal?.throwIfAborted();
        } catch (error) {
          await rm(outputDir, { recursive: true, force: true });
          throw error;
        }
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
