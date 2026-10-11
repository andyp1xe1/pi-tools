import type { ThreadTransport } from "../../bot/runtime.ts";
import type { Task } from "../domain.ts";
import type { Store } from "../store.ts";
import type { TelegramClient } from "./client.ts";
import { chunkParagraphs } from "./messages.ts";

export class TelegramThreadTransport implements ThreadTransport {
  constructor(
    private readonly client: TelegramClient,
    private readonly store: Store,
  ) {}
  private destination(task: Task) {
    return {
      chat_id: task.container.spaceId,
      ...(task.container.channelId === "general" ? {} : { message_thread_id: Number(task.container.channelId) }),
    };
  }
  async publishAnchor(task: Task, signal: AbortSignal): Promise<string> {
    const sent = await this.client.call(
      "sendMessage",
      { ...this.destination(task), text: `${task.title}\n${task.id}` },
      { signal },
    );
    return String(sent.message_id);
  }
  async reply(
    task: Task,
    messageId: string,
    text: string,
    mentions: string[],
    signal: AbortSignal,
    mapped: (id: string) => void,
  ): Promise<string[]> {
    if (!/^[1-9][0-9]*$/.test(messageId))
      throw new Error("Reply to a Telegram message ID from an input envelope or history.");
    const names = mentions.map((id) => {
      if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Invalid Telegram mention ID.");
      const name = this.store.userName(task.container, id);
      if (!name) throw new Error("Mentions must identify users previously seen in this project space.");
      return name;
    });
    const chunks = chunkParagraphs(`${names.length ? `${names.join(" ")}\n\n` : ""}${text}`);
    const ids: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      signal.throwIfAborted();
      let offset = 0;
      const entities =
        index === 0
          ? names.map((name, position) => {
              const entity = {
                type: "text_mention",
                offset,
                length: name.length,
                user: { id: Number(mentions[position]), is_bot: false, first_name: name },
              };
              offset += name.length + 1;
              return entity;
            })
          : [];
      const sent = await this.client.call(
        "sendMessage",
        {
          ...this.destination(task),
          text: chunk,
          ...(entities.length ? { entities } : {}),
          reply_parameters: { message_id: Number(messageId), allow_sending_without_reply: false },
        },
        { signal },
      );
      const id = String(sent.message_id);
      mapped(id);
      ids.push(id);
    }
    return ids;
  }
}
