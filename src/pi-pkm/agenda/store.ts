import { endOfWeek, startOfWeek } from "./dates.ts";
import { emacsAgendaProvider } from "./providers/emacs.ts";
import { sampleAgendaProvider } from "./providers/sample.ts";
import type { AgendaItem, AgendaProvider, AgendaSurface } from "./types.ts";

export type AgendaProviderFilter = "all" | string;

export class AgendaStore {
  readonly providers = new Map<string, AgendaProvider>();
  readonly providerItems = new Map<string, AgendaItem[]>();
  readonly providerErrors = new Map<string, string>();
  visible = false;
  surface: AgendaSurface = "widget";
  providerFilter: AgendaProviderFilter = "all";
  items: AgendaItem[] = [];
  selectedIndex = 0;
  scrollRow = 0;

  constructor(providers: AgendaProvider[]) {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }

  get providerLabel(): string {
    return this.providerLabelFor(this.providerFilter);
  }

  providerLabelFor(filter: AgendaProviderFilter): string {
    if (filter === "all") return "all";
    return this.providers.get(filter)?.label ?? filter;
  }

  async load(filter: AgendaProviderFilter = this.providerFilter): Promise<void> {
    this.providerFilter = filter;
    if (filter === "all") {
      await this.loadAllProviders();
    } else {
      await this.loadProvider(filter);
    }
    this.applyFilter();
  }

  async reload(): Promise<void> {
    await this.load(this.providerFilter);
  }

  toggleSurface(): AgendaSurface {
    this.surface = this.surface === "widget" ? "footer" : "widget";
    return this.surface;
  }

  cycleProviderFilter(delta: 1 | -1): void {
    const filters = this.providerFilters();
    const currentIndex = Math.max(0, filters.indexOf(this.providerFilter));
    this.providerFilter = filters[(currentIndex + delta + filters.length) % filters.length] ?? "all";
    this.applyFilter();
  }

  providerFilters(): AgendaProviderFilter[] {
    return ["all", ...this.providers.keys()];
  }

  selectedItem(): AgendaItem | undefined {
    return this.items[this.selectedIndex];
  }

  selectedText(): string {
    return this.items.length ? `${this.selectedIndex + 1}/${this.items.length}` : "0/0";
  }

  move(delta: number): void {
    const maxIndex = Math.max(0, this.items.length - 1);
    this.selectedIndex = Math.max(0, Math.min(maxIndex, this.selectedIndex + delta));
  }

  first(): void {
    this.selectedIndex = 0;
  }

  last(): void {
    this.selectedIndex = Math.max(0, this.items.length - 1);
  }

  async markSelectedDone(): Promise<{ ok: boolean; message?: string }> {
    const item = this.selectedItem();
    if (!item) return { ok: false, message: "No agenda item selected" };
    const provider = this.providers.get(item.providerId);
    if (!provider) return { ok: false, message: `Unknown agenda provider: ${item.providerId}` };
    const result = await provider.markDone(item);
    if (result.ok) {
      item.state = "DONE";
      const sourceItems = this.providerItems.get(item.providerId) ?? [];
      const sourceItem = sourceItems.find((candidate) => candidate.id === item.id);
      if (sourceItem) sourceItem.state = "DONE";
    }
    return result;
  }

  private async loadAllProviders(): Promise<void> {
    const query = this.query();
    this.providerErrors.clear();
    const providers = [...this.providers.values()];
    const results = await Promise.allSettled(providers.map(async (provider) => provider.listAgenda(query)));

    results.forEach((result, index) => {
      const provider = providers[index];
      if (!provider) return;
      if (result.status === "fulfilled") {
        this.providerItems.set(provider.id, result.value);
      } else {
        this.providerItems.delete(provider.id);
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.providerErrors.set(provider.id, message);
      }
    });
  }

  private async loadProvider(providerId: string): Promise<void> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Unknown agenda provider: ${providerId}`);
    this.providerErrors.delete(provider.id);
    try {
      this.providerItems.set(provider.id, await provider.listAgenda(this.query()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.providerErrors.set(provider.id, message);
      throw error;
    }
  }

  private applyFilter(): void {
    this.items = this.filteredItems().sort(compareAgendaItems);
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.items.length - 1));
    this.scrollRow = 0;
  }

  private filteredItems(): AgendaItem[] {
    if (this.providerFilter === "all") return [...this.providerItems.values()].flat();
    return [...(this.providerItems.get(this.providerFilter) ?? [])];
  }

  private query() {
    return { start: startOfWeek(new Date()), end: endOfWeek(new Date()) };
  }
}

function compareAgendaItems(a: AgendaItem, b: AgendaItem): number {
  return (
    a.day - b.day ||
    a.time.localeCompare(b.time) ||
    (a.source ?? "").localeCompare(b.source ?? "") ||
    a.title.localeCompare(b.title)
  );
}

export const agendaStore = new AgendaStore([sampleAgendaProvider, emacsAgendaProvider]);
