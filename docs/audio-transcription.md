# Audio transcription

`audio-transcription.ts` registers `transcribe_audio` when a `whisper` executable is available on `PATH`.

The tool is the audio counterpart to inspecting an image with `read`. It remains explicit because long recordings can require substantial CPU time.

## Usage

```text
transcribe_audio({ path: "/path/to/recording.ogg" })
```

Optional parameters:

- `model`: Whisper model name. Defaults to `base`.
- `language`: spoken language code such as `en`. When omitted, Whisper detects the language.

Set process-wide defaults with:

```bash
export PI_WHISPER_MODEL=small
export PI_WHISPER_LANGUAGE=en
```

Large results are truncated to pi's tool-output limits; the tool returns a path to the complete transcript.

## Nix integration

The pi-tools Home Manager module can install Whisper declaratively:

```nix
programs.pi-tools.audioTranscription.enable = true;
```

The default package is `pkgs.openai-whisper` and can be overridden through `programs.pi-tools.audioTranscription.package`.

## Telegram

See [telegram.md](telegram.md) to enable automatic voice-note transcription.
