import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BridgeClient } from "../agent-bridge/client.ts";

export interface ToolConnection extends Pick<BridgeClient, "sendAttachment" | "transcribeAudio"> {
  check(): void;
}

/** Capture the attachment before any file-system await. */
export function registerBotTools(pi: ExtensionAPI, capture: () => ToolConnection): void {
  pi.registerTool({
    name: "bot_attach",
    label: "Bot Attach",
    description: "Send local files immediately through the attached bot bridge.",
    promptSnippet: "Send local files through the attached bot bridge.",
    promptGuidelines: [
      "Use bot_attach to send requested files through the bridge, including requests from the terminal.",
      "When a bot message asks for a file or generated artifact, call bot_attach instead of only mentioning its local path.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1 }),
    }),
    execute: async (_id, params, signal, _update, ctx) => {
      const client = capture();
      signal?.throwIfAborted();
      const attachments = [];
      for (const input of params.paths) {
        const path = resolve(ctx.cwd, input);
        if (!(await stat(path)).isFile()) throw new Error(`Not a file: ${path}`);
        attachments.push({ path, fileName: basename(path) });
      }
      for (const attachment of attachments) await client.sendAttachment(attachment, signal);
      client.check();
      return {
        content: [{ type: "text", text: `Sent ${attachments.length} bot attachment(s).` }],
        details: { paths: attachments.map((attachment) => attachment.path), delivery: "immediate" },
      };
    },
  });
}
