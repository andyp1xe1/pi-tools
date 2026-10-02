import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAudioTranscription } from "../src/audio-transcription/index.ts";

export default async function audioTranscription(pi: ExtensionAPI): Promise<void> {
  await registerAudioTranscription(pi);
}
