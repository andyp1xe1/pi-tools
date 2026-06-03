import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgendaFooterComponent, AgendaPaneComponent, AgendaWidgetComponent } from "./renderer.ts";
import { type AgendaStore, agendaStore } from "./store.ts";
import type { AgendaItem, AgendaPaneResult } from "./types.ts";

const AGENDA_WIDGET_ID = "org-agenda";
const AGENDA_STATUS_ID = "org-agenda-status";

type AgendaContext = ExtensionCommandContext | ExtensionContext;

export class OrgAgendaController {
  private store: AgendaStore;

  constructor(store = agendaStore) {
    this.store = store;
  }

  async cycle(ctx: AgendaContext): Promise<void> {
    if (!this.store.visible) {
      if (!(await this.ensureLoaded(ctx))) return;
      this.store.visible = true;
      this.setPassive(ctx);
      ctx.ui.notify("Org agenda opened", "info");
      return;
    }

    await this.focus(ctx);
  }

  private async ensureLoaded(ctx: AgendaContext): Promise<boolean> {
    if (this.store.items.length) return true;
    try {
      await this.store.load("all");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Org agenda provider failed: ${message}`, "error");
      return false;
    }
  }

  private setPassive(ctx: AgendaContext): void {
    if (this.store.surface === "footer") {
      ctx.ui.setWidget(AGENDA_WIDGET_ID, undefined);
      ctx.ui.setFooter((_tui, theme) => new AgendaFooterComponent(theme, this.store));
    } else {
      ctx.ui.setFooter(undefined);
      ctx.ui.setWidget(AGENDA_WIDGET_ID, (tui, theme) => new AgendaWidgetComponent(tui, theme, this.store));
    }
    ctx.ui.setStatus(AGENDA_STATUS_ID, ctx.ui.theme.fg("accent", `◆ Org agenda ${this.store.selectedText()}`));
  }

  private clear(ctx: AgendaContext): void {
    ctx.ui.setWidget(AGENDA_WIDGET_ID, undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setStatus(AGENDA_STATUS_ID, undefined);
  }

  private async focus(ctx: AgendaContext): Promise<void> {
    const restorePassive = this.store.visible;
    if (restorePassive) this.clear(ctx);
    ctx.ui.notify("Org agenda focused", "info");

    const result = await ctx.ui.custom<AgendaPaneResult | undefined>(
      (tui, theme, _keybindings, done) => new AgendaPaneComponent(tui, theme, this.store, done),
    );

    if (result?.closeAgenda) {
      this.store.visible = false;
      this.clear(ctx);
      ctx.ui.notify("Org agenda closed", "info");
      return;
    }

    if (restorePassive) this.setPassive(ctx);
    if (result?.item) this.notifySelected(ctx, result.item);
  }

  private notifySelected(ctx: AgendaContext, item: AgendaItem): void {
    ctx.ui.notify(`Org agenda selected: ${item.title}`, "info");
  }
}

export const orgAgenda = new OrgAgendaController();
