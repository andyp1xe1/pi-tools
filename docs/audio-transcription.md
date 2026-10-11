# Audio transcription

`transcribe_audio` has one shared implementation used by the audio and bot integrations. Loading both extensions registers one tool, regardless of load order.

```text
transcribe_audio({ path: "/path/to/recording.ogg" })
```

- While the bot bridge is attached, the tool delegates to the daemon.
- While detached, it uses local Whisper when `whisper` is on Pi's `PATH`.
- The standalone audio extension is available when local Whisper is installed. The bot integration also supplies the tool without local Whisper; attach the bridge to use daemon transcription in that case.
- `model` selects a Whisper model. Omit it for daemon defaults while attached, or `base` locally.
- `language` sets the spoken language, such as `en`. Omit it for detection.
- `PI_WHISPER_MODEL` and `PI_WHISPER_LANGUAGE` set local defaults. The daemon also supports `AGENT_BRIDGE_WHISPER_*` overrides.

The tool captures the active backend before asynchronous file validation. Detaching or changing attachments cannot redirect an in-flight request to a new session, and daemon failure never triggers local fallback. Cancellation applies to validation, execution, and transcript-file writing.

Long transcripts are truncated to Pi's tool-output limits and include a path to the complete private local text file.

Enable local Whisper with `programs.pi-tools.audioTranscription.enable = true;`. Override its package with `audioTranscription.package`. The daemon must have Whisper on its own `PATH` for incoming voice preprocessing and remote tool requests.

The [bot integration](bot.md) includes incoming voice transcripts in prepared messages; do not retranscribe them unless requested.
