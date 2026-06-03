import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { buildWeekDays, timeToMinutes, weekLabel } from "./dates.ts";
import type { AgendaStore } from "./store.ts";
import type { AgendaPaneResult, AgendaRow } from "./types.ts";

export class AgendaWidgetComponent implements Component {
  private tui: TUI;
  private theme: Theme;
  private store: AgendaStore;
  private timer: NodeJS.Timeout;

  constructor(tui: TUI, theme: Theme, store: AgendaStore) {
    this.tui = tui;
    this.theme = theme;
    this.store = store;
    this.timer = setInterval(() => this.tui.requestRender(), 30_000);
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(42, width - 2);
    const lines = renderAgendaBody(this.theme, this.store, bodyWidth, ["Alt+X focus · /org-agenda hide"], 7);
    return boxLines(this.theme, " Org agenda ", lines, width);
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}

export class AgendaFooterComponent implements Component {
  private theme: Theme;
  private store: AgendaStore;

  constructor(theme: Theme, store: AgendaStore) {
    this.theme = theme;
    this.store = store;
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(42, width - 2);
    const lines = renderAgendaBody(this.theme, this.store, bodyWidth, ["Alt+X focus · footer mode"], 3);
    return boxLines(this.theme, " Org agenda ", lines, width);
  }

  invalidate(): void {}
}

export class AgendaPaneComponent implements Component {
  private tui: TUI;
  private theme: Theme;
  private store: AgendaStore;
  private done: (value: AgendaPaneResult | undefined) => void;

  constructor(tui: TUI, theme: Theme, store: AgendaStore, done: (value: AgendaPaneResult | undefined) => void) {
    this.tui = tui;
    this.theme = theme;
    this.store = store;
    this.done = done;
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(42, width - 2);
    const lines = renderAgendaBody(
      this.theme,
      this.store,
      bodyWidth,
      [`j/k scroll · h/l source · f passive=${this.store.surface} · PgUp/PgDn jump · esc restore · q close`],
      12,
    );
    return boxLines(this.theme, " Org agenda ", lines, width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || data === "k") this.store.move(-1);
    if (matchesKey(data, Key.down) || data === "j") this.store.move(1);
    if (matchesKey(data, Key.left) || data === "h") this.store.cycleProviderFilter(-1);
    if (matchesKey(data, Key.right) || data === "l") this.store.cycleProviderFilter(1);
    if (data === "f") this.store.toggleSurface();
    if (matchesKey(data, Key.pageUp)) this.store.move(-5);
    if (matchesKey(data, Key.pageDown)) this.store.move(5);
    if (data === "g") this.store.first();
    if (data === "G") this.store.last();
    if (matchesKey(data, Key.enter) && this.store.selectedItem()) this.done({ item: this.store.selectedItem() });
    if (matchesKey(data, Key.alt("x")) || data === "q") this.done({ closeAgenda: true });
    if (matchesKey(data, Key.escape)) this.done(undefined);
    this.tui.requestRender();
  }

  invalidate(): void {}
}

function renderAgendaBody(
  theme: Theme,
  store: AgendaStore,
  width: number,
  footer: string[],
  maxRows?: number,
): string[] {
  const rows = buildAgendaRows(store);
  const selectedRow = rows.findIndex((row) => row.type === "entry" && row.itemIndex === store.selectedIndex);
  const visibleRows = maxRows ? scrollAgendaRows(store, rows, selectedRow, maxRows) : rows;

  const providerSummary = store
    .providerFilters()
    .map((filter) =>
      filter === store.providerFilter ? `[${store.providerLabelFor(filter)}]` : store.providerLabelFor(filter),
    )
    .join(" ");
  const lines = [theme.fg("accent", `Week-agenda: ${providerSummary}`), theme.fg("mdHeading", weekLabel())];
  if (maxRows && store.scrollRow > 0) lines.push(theme.fg("muted", `  ↑ ${store.scrollRow} earlier rows`));
  for (const row of visibleRows) {
    if (row.type === "day") {
      lines.push(theme.fg("mdHeading", row.label));
      continue;
    }
    if (row.type === "time") {
      lines.push(timeLine(theme, row));
      continue;
    }
    lines.push(agendaEntryLine(theme, row, row.itemIndex === store.selectedIndex, width));
  }
  const hiddenBelow = rows.length - (store.scrollRow + visibleRows.length);
  if (maxRows && hiddenBelow > 0) lines.push(theme.fg("muted", `  ↓ ${hiddenBelow} later rows`));
  if (store.providerErrors.size)
    lines.push(theme.fg("warning", `provider errors: ${[...store.providerErrors.keys()].join(", ")}`));
  lines.push(theme.fg("muted", `entry ${store.selectedText()}`));
  lines.push(...footer.map((line) => theme.fg("muted", line)));
  return lines;
}

function scrollAgendaRows(store: AgendaStore, rows: AgendaRow[], selectedRow: number, maxRows: number): AgendaRow[] {
  const viewportRows = Math.max(1, maxRows);
  const maxScroll = Math.max(0, rows.length - viewportRows);
  if (selectedRow >= 0) {
    if (selectedRow < store.scrollRow) store.scrollRow = selectedRow;
    if (selectedRow >= store.scrollRow + viewportRows) store.scrollRow = selectedRow - viewportRows + 1;
  }
  store.scrollRow = Math.max(0, Math.min(maxScroll, store.scrollRow));
  return rows.slice(store.scrollRow, store.scrollRow + viewportRows);
}

function buildAgendaRows(store: AgendaStore): AgendaRow[] {
  const rows: AgendaRow[] = [];
  const now = new Date();
  const nowLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const currentDay = now.getDay() || 7;
  const currentMinute = now.getHours() * 60 + now.getMinutes();

  for (const day of buildWeekDays()) {
    rows.push({ type: "day", label: day.label });
    const timedRows: Array<{ minute: number; row: AgendaRow; order: number }> = [];
    if (day.index === currentDay) {
      for (const hour of [8, 10, 12, 14, 16, 18, 20]) {
        timedRows.push({
          minute: hour * 60,
          row: { type: "time", label: `${String(hour).padStart(2, "0")}:00`, text: "----------------" },
          order: 0,
        });
      }
      timedRows.push({
        minute: currentMinute,
        row: { type: "time", label: nowLabel, text: "now - - - - - - - - - - - -", now: true },
        order: 1,
      });
    }

    store.items.forEach((item, itemIndex) => {
      if (item.day !== day.index) return;
      timedRows.push({ minute: timeToMinutes(item.time), row: { type: "entry", item, itemIndex }, order: 2 });
    });

    timedRows.sort((a, b) => a.minute - b.minute || a.order - b.order);
    rows.push(...timedRows.map(({ row }) => row));
  }
  return rows;
}

function timeLine(theme: Theme, row: Extract<AgendaRow, { type: "time" }>): string {
  const label = `  ${row.label}......`;
  if (row.now) return `${theme.fg("warning", label)} ${theme.fg("muted", row.text)}`;
  return `${theme.fg("muted", label)} ${theme.fg("muted", row.text)}`;
}

function agendaEntryLine(
  theme: Theme,
  row: Extract<AgendaRow, { type: "entry" }>,
  selected: boolean,
  width: number,
): string {
  const source = `${row.item.source ?? "pi"}:`.padEnd(9);
  const line = truncateToWidth(agendaEntryText(theme, row.item, source), width);
  return selected ? theme.bg("selectedBg", padVisible(line, Math.min(width, visibleWidth(line) + 2))) : line;
}

function agendaEntryText(theme: Theme, item: Extract<AgendaRow, { type: "entry" }>["item"], source: string): string {
  const parts = [
    item.agendaPrefix ? agendaPrefixText(theme, item.agendaPrefix) : "",
    item.state ? stateText(theme, item.state) : "",
    item.priority ? priorityText(theme, item.priority) : "",
    item.title,
    item.tags.length ? theme.fg("muted", `:${item.tags.join(":")}:`) : "",
  ].filter(Boolean);
  return `  ${source} ${(item.timeRange ?? item.time).padEnd(11)} ${parts.join(" ")}`;
}

function agendaPrefixText(theme: Theme, prefix: string): string {
  if (prefix.startsWith("Deadline")) return theme.fg("error", prefix);
  if (prefix.startsWith("Scheduled")) return theme.fg("accent", prefix);
  return theme.fg("warning", prefix);
}

function priorityText(
  theme: Theme,
  priority: NonNullable<Extract<AgendaRow, { type: "entry" }>["item"]["priority"]>,
): string {
  const color = priority === "A" ? "error" : priority === "B" ? "warning" : "muted";
  return theme.fg(color, `[#${priority}]`);
}

function stateText(theme: Theme, state: NonNullable<Extract<AgendaRow, { type: "entry" }>["item"]["state"]>): string {
  if (state === "DONE") return theme.fg("success", "DONE");
  if (state === "WAIT") return theme.fg("muted", "WAIT");
  return theme.fg("warning", "TODO");
}

function boxLines(theme: Theme, title: string, content: string[], width: number): string[] {
  const safeWidth = Math.max(24, width);
  const topTitle = ` ${title.trim()} `;
  const top = `${theme.fg("muted", "╭")}${theme.fg("muted", topTitle)}${theme.fg("muted", "─".repeat(Math.max(0, safeWidth - visibleWidth(topTitle) - 2)))}${theme.fg("muted", "╮")}`;
  const bottom = `${theme.fg("muted", "╰")}${theme.fg("muted", "─".repeat(Math.max(0, safeWidth - 2)))}${theme.fg("muted", "╯")}`;
  const innerWidth = Math.max(1, safeWidth - 2);
  return [
    top,
    ...content.map(
      (line) =>
        `${theme.fg("muted", "│")}${padVisible(truncateToWidth(line, innerWidth), innerWidth)}${theme.fg("muted", "│")}`,
    ),
    bottom,
  ];
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
