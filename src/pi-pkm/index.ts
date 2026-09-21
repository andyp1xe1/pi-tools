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

  pi.registerCommand("org-agenda-refresh", {
    description: "Reload agenda providers and redraw the current agenda",
    handler: async (_args, ctx) => {
      await orgAgenda.refresh(ctx);
    },
  });

  pi.registerCommand("org-agenda-done", {
    description: "Mark the selected agenda item DONE when its provider supports it",
    handler: async (_args, ctx) => {
      await orgAgenda.markSelectedDone(ctx);
    },
  });

  pi.registerShortcut(Key.alt("x"), {
    description: "Cycle Org agenda: passive view → pane → close",
    handler: async (ctx) => {
      await orgAgenda.cycle(ctx);
    },
  });
}
