# Audio transcription

`transcribe_audio` transcribes a local audio file with Whisper. The tool requires `whisper` on `PATH`.

```text
transcribe_audio({ path: "/path/to/recording.ogg" })
```

- `model` selects a Whisper model. The default is `base`.
- `language` sets the spoken language, such as `en`. Omit it for detection.
- `PI_WHISPER_MODEL` and `PI_WHISPER_LANGUAGE` set process-wide defaults.

Long transcripts include a path to the complete text.

Enable Whisper with `programs.pi-tools.audioTranscription.enable = true;`. Override its package with `audioTranscription.package`.

The [Telegram bridge](telegram.md) transcribes voice messages when this feature is enabled.
