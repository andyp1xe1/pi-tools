import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, parse } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WhisperTranscriptionOptions {
  executable?: string;
  model?: string;
  language?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  tempRoot?: string;
}

export async function findExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return undefined;
}

export async function transcribeWithWhisper(
  pi: ExtensionAPI,
  audioPath: string,
  options: WhisperTranscriptionOptions = {},
): Promise<string> {
  const executable = options.executable ?? (await findExecutable("whisper"));
  if (!executable) throw new Error("Whisper is not available on PATH");

  const model = options.model?.trim() || "base";
  const outputDir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "pi-whisper-"));

  try {
    const args = [audioPath, "--model", model, "--output_dir", outputDir, "--output_format", "txt", "--fp16", "False"];
    if (options.language?.trim()) args.push("--language", options.language.trim());

    const result = await pi.exec(executable, args, {
      signal: options.signal,
      timeout: options.timeoutMs ?? 30 * 60 * 1000,
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-2000);
      throw new Error(detail || `Whisper exited with code ${result.code}`);
    }

    const transcriptPath = join(outputDir, `${parse(audioPath).name}.txt`);
    const transcript = (await readFile(transcriptPath, "utf8")).trim();
    if (!transcript) throw new Error("Whisper produced an empty transcript");
    return transcript;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
