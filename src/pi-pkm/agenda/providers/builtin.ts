import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dayIndexForDate } from "../dates.ts";
import type { AgendaItem, AgendaItemState, AgendaPriority, AgendaProvider, AgendaQuery } from "../types.ts";

const BUILTIN_FILE = ".pi-pkm/agenda.txt";

export const builtinProvider: AgendaProvider = {
  id: "builtin",
  label: "builtin",
  async listAgenda(query) {
    const file = await builtinFilePath(query);
    await ensureBuiltinFile(file);
    const text = await readFile(file, "utf8");
    return parseBuiltinAgenda(text, file, query.start);
  },
  async markDone(item) {
    if (!item.file || !item.line) return { ok: false, message: "builtin item does not include a file and line" };
    const text = await readFile(item.file, "utf8");
    const lines = text.split(/\r?\n/);
    const index = item.line - 1;
    const line = lines[index];
    if (!line) return { ok: false, message: "builtin agenda line no longer exists" };
    if (/^\s*DONE\b/.test(line)) return { ok: true, message: `Already done: ${item.title}` };
    lines[index] = /^\s*(TODO|WAIT)\b/.test(line) ? line.replace(/^\s*(TODO|WAIT)\b/, "DONE") : `DONE ${line}`;
    await writeFile(item.file, lines.join("\n"), "utf8");
    return { ok: true, message: `Marked done in builtin agenda: ${item.title}` };
  },
};

async function builtinFilePath(query: AgendaQuery): Promise<string> {
  const root = await nearestGitRoot(query.cwd ?? process.cwd());
  return join(root, BUILTIN_FILE);
}

async function nearestGitRoot(start: string): Promise<string> {
  let current = start;
  while (true) {
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureBuiltinFile(file: string): Promise<void> {
  if (await exists(file)) return;
  await mkdir(dirname(file), { recursive: true });
  const today = formatDate(new Date());
  await writeFile(
    file,
    [
      "# pi-pkm builtin agenda",
      "# Format: TODO YYYY-MM-DD HH:MM [#B] Task title +tag @context",
      "# States: TODO, WAIT, DONE. Priorities: [#A], [#B], [#C].",
      `TODO ${today} 09:00 [#B] Add your first project agenda item +pi`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function parseBuiltinAgenda(text: string, file: string, reference: Date): AgendaItem[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => parseBuiltinLine(line, file, index + 1, reference))
    .filter((item): item is AgendaItem => Boolean(item));
}

function parseBuiltinLine(line: string, file: string, lineNumber: number, reference: Date): AgendaItem | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return;

  const match =
    /^(?:(TODO|DONE|WAIT)\s+)?(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2})(?:-(\d{1,2}:\d{2}))?)?(?:\s+\[#([ABC])\])?\s+(.+)$/.exec(
      trimmed,
    );
  if (!match) return;

  const [, state = "TODO", dateText, startTime = "00:00", endTime, priority, titleText] = match;
  const date = parseDate(dateText);
  if (!date) return;
  const day = dayIndexForDate(date, reference);
  if (!day) return;

  const time = normalizeTime(startTime);
  const end = endTime ? normalizeTime(endTime) : undefined;
  const title = titleText
    .replace(/(^|\s)[+@][A-Za-z0-9_-]+/g, "")
    .replace(/\s+:([A-Za-z0-9_-]+:)+\s*$/g, "")
    .trim();

  return {
    id: `builtin:${file}:${lineNumber}`,
    providerId: "builtin",
    state: state as AgendaItemState,
    priority: priority as AgendaPriority | undefined,
    title,
    day,
    time,
    timeRange: end ? `${time}-${end}` : time,
    tags: tagsFrom(titleText),
    source: "builtin",
    file,
    line: lineNumber,
    raw: line,
  };
}

function parseDate(text: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function normalizeTime(time: string): string {
  const [hour = "0", minute = "00"] = time.split(":");
  return `${hour.padStart(2, "0")}:${minute}`;
}

function tagsFrom(text: string): string[] {
  const tags = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)[+@]([A-Za-z0-9_-]+)/g)) tags.add(match[1]);
  for (const match of text.matchAll(/:([A-Za-z0-9_-]+)(?=:)/g)) tags.add(match[1]);
  return [...tags];
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
