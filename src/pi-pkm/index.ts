import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { orgAgenda } from "./agenda/controller.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("org-agenda", {
    description: "Cycle Org agenda: passive view → pane → close",
    handler: async (_args, ctx) => {
      await orgAgenda.cycle(ctx);
    },
  });

  pi.registerShortcut(Key.alt("x"), {
    description: "Cycle Org agenda: passive view → pane → close",
    handler: async (ctx) => {
      await orgAgenda.cycle(ctx);
    },
  });
}
