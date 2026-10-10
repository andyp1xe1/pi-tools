import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramPickers } from "../../../src/agent-bridge/telegram/pickers.ts";

function fixture(providers) {
  const calls = [];
  const snapshot = {
    idle: true, thinking: "off", supportedThinking: ["off"], status: "ready",
    models: providers.map((provider, index) => ({ provider, id: `m${index}`, name: `Model ${index}` })),
  };
  const agent = { current: () => true, snapshot: async () => snapshot };
  const client = {
    sendText: async (...args) => calls.push({ method: "text", args }),
    sendMenu: async (_chatId, _text, markup) => calls.push({ method: "menu", markup }),
    editMenu: async (_chatId, _messageId, _text, markup) => calls.push({ method: "edit", markup }),
    answerCallbackQuery: async () => {},
  };
  const pickers = new TelegramPickers(agent, client);
  const callback = (button) => pickers.handleCallback({
    id: "callback", from: { id: 7, is_bot: false },
    message: { message_id: 50, chat: { id: 7, type: "private" } }, data: button.callback_data,
  });
  return { pickers, snapshot, calls, callback };
}

test("zero providers report no authenticated models; returning to an empty root yields no buttons", async () => {
  const h = fixture([]);
  await h.pickers.showModelPicker(7);
  assert.deepEqual(h.calls, [{ method: "text", args: [7, 0, "No authenticated models are available."] }]);

  h.snapshot.models = [{ provider: "only", id: "m", name: "Model" }];
  await h.pickers.showModelPicker(7);
  await h.callback(h.calls.at(-1).markup.inline_keyboard[0][0]);
  const back = h.calls.at(-1).markup.inline_keyboard.at(-1)[0];
  h.snapshot.models = [];
  await h.callback(back);
  assert.deepEqual(h.calls.at(-1), { method: "edit", markup: { inline_keyboard: [] } });
});

test("one provider uses the generic root row and still opens its model page", async () => {
  const h = fixture(["only", "only"]);
  await h.pickers.showModelPicker(7);
  assert.deepEqual(h.calls[0].markup, { inline_keyboard: [[{ text: "only", callback_data: "bridge:1" }]] });
  await h.callback(h.calls[0].markup.inline_keyboard[0][0]);
  assert.deepEqual(h.calls.at(-1).markup.inline_keyboard.map((row) => row.map((button) => button.text)), [
    ["Model 0"], ["Model 1"], ["‹ Providers"],
  ]);
});

test("multiple providers are deduplicated, sorted and arranged in two-button root rows", async () => {
  const h = fixture(["z", "c", "a", "b", "c", "d"]);
  await h.pickers.showModelPicker(7);
  assert.deepEqual(h.calls[0].markup, { inline_keyboard: [
    [{ text: "a", callback_data: "bridge:1" }, { text: "b", callback_data: "bridge:2" }],
    [{ text: "c", callback_data: "bridge:3" }, { text: "d", callback_data: "bridge:4" }],
    [{ text: "z", callback_data: "bridge:5" }],
  ] });
});
