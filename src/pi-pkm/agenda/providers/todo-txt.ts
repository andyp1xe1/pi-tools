import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dayIndexForDate } from "../dates.ts";
import type { AgendaItem, AgendaItemState, AgendaPriority, AgendaProvider, AgendaQuery } from "../types.ts";

export const todoTxtProvider: AgendaProvider = {
  id: "todo.txt",
  label: "todo.txt",
  async listAgenda(query) {
    const file = await todoFilePath(query);
    if (!file) return [];
    const text = await readFile(file, "utf8");
    return parseTodoTxt(text, file, query.start);
  },
  async markDone(item) {
    if (!item.file || !item.line) return { ok: false, message: "todo.txt item does not include a file and line" };
    const text = await readFile(item.file, "utf8");
    const lines = text.split(/\r?\n/);
    const index = item.line - 1;
    const line = lines[index];
    if (!line) return { ok: false, message: "todo.txt line no longer exists" };
    if (/^\s*x\s+/.test(line)) return { ok: true, message: `Already done: ${item.title}` };
    lines[index] = completeTodoLine(line, new Date());
    await writeFile(item.file, lines.join("\n"), "utf8");
    return { ok: true, message: `Marked done in todo.txt: ${item.title}` };
  },
};

async function todoFilePath(query: AgendaQuery): Promise<string | undefined> {
  const configured = process.env.TODO_FILE || process.env.TODOTXT_FILE;
  if (configured) return configured;
  return findUp(query.cwd ?? process.cwd(), "todo.txt");
}

async function findUp(start: string, filename: string): Promise<string | undefined> {
  let current = start;
  while (true) {
    const candidate = join(current, filename);
    if (await fileExists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function parseTodoTxt(text: string, file: string, reference: Date): AgendaItem[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => parseTodoLine(line, file, index + 1, reference))
    .filter((item): item is AgendaItem => Boolean(item));
}

function parseTodoLine(line: string, file: string, lineNumber: number, reference: Date): AgendaItem | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return;

  const parsed = parseTodoParts(trimmed);
  const agendaDateText = parsed.due ?? parsed.completedDate;
  if (!agendaDateText) return;
  const agendaDate = parseDate(agendaDateText);
  if (!agendaDate) return;
  const day = dayIndexForDate(agendaDate, reference);
  if (!day) return;

  return {
    id: `todo.txt:${file}:${lineNumber}`,
    providerId: "todo.txt",
    state: parsed.done ? "DONE" : ("TODO" as AgendaItemState),
    priority: agendaPriority(parsed.priority),
    title: cleanTitle(parsed.body),
    day,
    time: "00:00",
    timeRange: "00:00",
    tags: tagsFrom(parsed.body),
    source: "todo.txt",
    file,
    line: lineNumber,
    raw: line,
  };
}

interface TodoParts {
  done: boolean;
  completedDate?: string;
  priority?: string;
  createdDate?: string;
  due?: string;
  body: string;
}

function parseTodoParts(line: string): TodoParts {
  let rest = line;
  let done = false;
  let completedDate: string | undefined;
  let priority: string | undefined;
  let createdDate: string | undefined;

  if (rest.startsWith("x ")) {
    done = true;
    rest = rest.slice(2).trimStart();
    const taken = takeIsoDate(rest);
    if (taken) {
      completedDate = taken.date;
      rest = taken.rest;
    }
  }

  if (!done) {
    const match = /^\(([A-Z])\)\s+/.exec(rest);
    if (match) {
      priority = match[1];
      rest = rest.slice(match[0].length);
    }
  }

  const created = takeIsoDate(rest);
  if (created) {
    createdDate = created.date;
    rest = created.rest;
  }

  return { done, completedDate, priority, createdDate, due: findKeyValue(rest, "due"), body: rest.trim() };
}

function takeIsoDate(text: string): { date: string; rest: string } | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})(?:\s+|$)/.exec(text);
  if (!match || !parseDate(match[1])) return;
  return { date: match[1], rest: text.slice(match[0].length).trimStart() };
}

function findKeyValue(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)${escaped}:([^\\s]+)`).exec(text);
  return match?.[1];
}

function parseDate(text: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day))
    return;
  return date;
}

function agendaPriority(priority: string | undefined): AgendaPriority | undefined {
  return priority === "A" || priority === "B" || priority === "C" ? priority : undefined;
}

function cleanTitle(text: string): string {
  return text
    .replace(/(?:^|\s)[+@][A-Za-z0-9_-]+/g, "")
    .replace(/(?:^|\s)[A-Za-z0-9_-]+:[^\s]+/g, "")
    .trim();
}

function tagsFrom(text: string): string[] {
  const tags = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)[+@]([A-Za-z0-9_-]+)/g)) tags.add(match[1]);
  return [...tags];
}

function completeTodoLine(line: string, today: Date): string {
  const trimmed = line.trim();
  const match = /^\([A-Z]\)\s+/.exec(trimmed);
  const withoutPriority = match ? trimmed.slice(match[0].length) : trimmed;
  return `x ${formatDate(today)} ${withoutPriority}`;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
