export type AgendaItemState = "TODO" | "DONE" | "WAIT";
export type AgendaPriority = "A" | "B" | "C";
export type AgendaSurface = "widget" | "footer";

export interface AgendaItem {
  id: string;
  providerId: string;
  state?: AgendaItemState;
  priority?: AgendaPriority;
  title: string;
  day: number;
  time: string;
  timeRange?: string;
  agendaPrefix?: string;
  tags: string[];
  source?: string;
  file?: string;
  line?: number;
  raw?: unknown;
}

export type AgendaRow =
  | { type: "day"; label: string }
  | { type: "time"; label: string; text: string; now?: boolean }
  | { type: "entry"; item: AgendaItem; itemIndex: number };

export interface AgendaPaneResult {
  item?: AgendaItem;
  closeAgenda?: boolean;
}

export interface AgendaQuery {
  start: Date;
  end: Date;
}

export interface AgendaMutationResult {
  ok: boolean;
  message?: string;
}

export interface AgendaProvider {
  id: string;
  label: string;
  listAgenda(query: AgendaQuery): Promise<AgendaItem[]>;
  markDone(item: AgendaItem): Promise<AgendaMutationResult>;
}
