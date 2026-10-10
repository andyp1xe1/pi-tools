import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelegramTurn } from "../../../src/agent-bridge/telegram/turn.ts";
import { collectTelegramFileInfos } from "../../../src/agent-bridge/telegram/media.ts";

const categories = [["document", ""], ["video", ".mp4"], ["audio", ".mp3"], ["voice", ".ogg"], ["animation", ".mp4"]];

test("media metadata matrix preserves kind, MIME, supplied filename and exact fallback rules", () => {
  const mimes = [
    [undefined, undefined], ["unknown/type", undefined], ["IMAGE/JPEG", ".jpg"],
    ["image/png", ".png"], ["image/webp", ".webp"], ["image/gif", ".gif"],
    ["image/unknown", undefined], ["audio/ogg", ".ogg"], ["audio/mpeg", ".mp3"],
    ["audio/wav", ".wav"], ["video/mp4", ".mp4"], ["application/pdf", ".pdf"],
  ];
  for (const [kind, fallback] of categories) {
    for (const [mimeType, extension] of mimes) {
      for (const supplied of [undefined, "", "supplied name.custom"]) {
        const message = { message_id: 42, [kind]: { file_id: kind, file_name: supplied, mime_type: mimeType } };
        const generated = `${kind}-42${extension ?? fallback}`;
        assert.deepEqual(collectTelegramFileInfos([message]), [{
          file_id: kind,
          fileName: kind === "voice" ? generated : supplied || generated,
          mimeType,
          isImage: kind === "document" && !!mimeType?.toLowerCase().startsWith("image/"),
          isVoice: kind === "voice",
        }], `${kind}/${mimeType}/${supplied}`);
      }
    }
  }
});

test("media categories stay ordered and independent, including document/animation aliases", async () => {
  const message = {
    message_id: 42, chat: { id: 7, type: "private" },
    photo: [{ file_id: "small", file_size: 1 }, { file_id: "large", file_size: 20 }, { file_id: "unsized" }],
    ...Object.fromEntries(categories.map(([kind]) => [kind, { file_id: kind === "animation" ? "document" : kind }])),
    sticker: { file_id: "sticker" },
  };
  const infos = collectTelegramFileInfos([message]);
  assert.deepEqual(infos, [
    { file_id: "large", fileName: "photo-42.jpg", mimeType: "image/jpeg", isImage: true, isVoice: false },
    ...categories.map(([kind, fallback]) => ({
      file_id: kind === "animation" ? "document" : kind, fileName: `${kind}-42${fallback}`,
      mimeType: undefined, isImage: false, isVoice: kind === "voice",
    })),
    { file_id: "sticker", fileName: "sticker-42.webp", mimeType: "image/webp", isImage: true, isVoice: false },
  ]);
  assert.deepEqual(collectTelegramFileInfos([message, { ...message, message_id: 43 }]).map(info => info.fileName), [
    ...infos.map(info => info.fileName), ...infos.map(info => info.fileName.replace("42", "43")),
  ]);
  const downloads = [], transcriptions = [];
  await createTelegramTurn({
    downloadFile: async (id, name) => { downloads.push({ id, name }); return `/tmp/${name}`; },
    transcribeAudio: async path => { transcriptions.push(path); return "voice transcript"; },
  }, [message]);
  assert.deepEqual(downloads, infos.map(info => ({ id: info.file_id, name: info.fileName })));
  assert.deepEqual(transcriptions, ["/tmp/voice-42.ogg"]);
});

test("photo choice and sticker flags retain explicit static-image and animation precedence", () => {
  assert.deepEqual(collectTelegramFileInfos([{ message_id: 1, photo: [] }]), []);
  for (const [flags, extension, mimeType, isImage] of [
    [{}, ".webp", "image/webp", true],
    [{ is_animated: false, is_video: false }, ".webp", "image/webp", true],
    [{ is_animated: true }, ".tgs", "application/x-tgsticker", false],
    [{ is_video: true }, ".webm", "video/webm", false],
    [{ is_animated: true, is_video: true }, ".tgs", "application/x-tgsticker", false],
  ]) {
    assert.deepEqual(collectTelegramFileInfos([{ message_id: 1, sticker: { file_id: "sticker", ...flags } }]), [{
      file_id: "sticker", fileName: `sticker-1${extension}`, mimeType, isImage, isVoice: false,
    }]);
  }
});

const voice = { message_id: 1, chat: { id: 7, type: "private" }, voice: { file_id: "voice" } };
function client(transcribeAudio) {
  return { downloadFile: async () => "/tmp/voice.ogg", transcribeAudio };
}

test("voice failures retain only the bounded error tail in the prompt", async () => {
  for (const error of [new Error(`${"x".repeat(2000)}tail`), `${"x".repeat(2000)}tail`]) {
    const turn = await createTelegramTurn(client(async () => { throw error; }), [voice]);
    assert.equal(turn.content[0].text,
      `[telegram]\n\nLocal transcription of voice-1.ogg failed: ${"x".repeat(996)}tail` +
      "\n\nTelegram attachments were saved locally:\n- /tmp/voice.ogg");
  }
});

test("voice AbortError is rethrown rather than embedded as a transcription failure", async () => {
  const error = new DOMException("cancelled", "AbortError");
  await assert.rejects(createTelegramTurn(client(async () => { throw error; }), [voice]), (value) => value === error);
});

test("voice cancellation rethrows even a non-AbortError from the transport", async () => {
  const controller = new AbortController();
  const error = new Error("transport stopped");
  await assert.rejects(createTelegramTurn(client(async () => {
    controller.abort();
    throw error;
  }), [voice], controller.signal), (value) => value === error);
});
