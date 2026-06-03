import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dayIndexForDate } from "../dates.ts";
import type { AgendaItem, AgendaProvider } from "../types.ts";

const execFileAsync = promisify(execFile);

interface EmacsAgendaRow {
  category: string;
  date: [number, number, number];
  extra?: string;
  file?: string;
  lineNumber?: number;
  priority?: string;
  rawLine: string;
  state?: string;
  tags: string[];
  time: string;
  title: string;
}

export const emacsAgendaProvider: AgendaProvider = {
  id: "emacs",
  label: "emacs",
  async listAgenda(query) {
    const { stdout } = await execFileAsync("emacsclient", ["--eval", emacsAgendaEval()], { timeout: 10_000 });
    return parseEmacsAgendaRows(parseEmacsEvalString(stdout), query.start);
  },
  async markDone() {
    return { ok: false, message: "Emacs mark-done is reserved but not implemented yet" };
  },
};

function parseEmacsEvalString(stdout: string): string {
  const text = stdout.trim();
  if (!text.startsWith('"')) throw new Error("Expected emacsclient to return a JSON string");
  return JSON.parse(text);
}

function parseEmacsAgendaRows(json: string, reference: Date): AgendaItem[] {
  const rows = JSON.parse(json) as EmacsAgendaRow[];
  if (!Array.isArray(rows)) throw new Error("Expected Emacs agenda JSON to be an array");

  return rows.map((row, index) => {
    const [month, day, year] = row.date;
    const [start, end] = row.time.split("-");
    const normalizedStart = normalizeTime(start);
    const timeRange = end ? `${normalizedStart}-${normalizeTime(end)}` : normalizedStart;

    return {
      id: `emacs:${row.file ?? row.category}:${row.lineNumber ?? index}:${row.time}`,
      providerId: "emacs",
      state: agendaState(row.state),
      priority: agendaPriority(row.priority),
      title: row.title.trim(),
      day: dayIndexForDate(new Date(year, month - 1, day), reference),
      time: normalizedStart,
      timeRange,
      agendaPrefix: row.extra?.trim(),
      tags: row.tags,
      source: row.category,
      file: row.file,
      line: row.lineNumber,
      raw: row.rawLine,
    };
  });
}

function agendaState(state: string | undefined): AgendaItem["state"] | undefined {
  if (state === "DONE" || state === "WAIT" || state === "TODO") return state;
}

function agendaPriority(priority: string | undefined): AgendaItem["priority"] | undefined {
  if (priority === "A" || priority === "B" || priority === "C") return priority;
}

function normalizeTime(time: string): string {
  const match = /\d{1,2}:\d{2}/.exec(time);
  if (!match) return "00:00";
  return match[0].length === 4 ? `0${match[0]}` : match[0];
}

function emacsAgendaEval(): string {
  return `(progn
  (require 'calendar)
  (require 'json)
  (require 'org)
  (require 'org-agenda)
  (defun pi-pkm-agenda-line-property (property beg end)
    (let ((pos beg) value)
      (while (and (< pos end) (not value))
        (setq value (get-text-property pos property))
        (setq pos (or (next-single-property-change pos property nil end) end)))
      value))
  (defun pi-pkm-agenda-at-marker (marker fn)
    (when (and marker (marker-buffer marker))
      (with-current-buffer (marker-buffer marker)
        (save-excursion
          (goto-char marker)
          (funcall fn)))))
  (defun pi-pkm-agenda-local-tags (marker)
    (pi-pkm-agenda-at-marker marker (lambda () (org-get-tags nil t))))
  (defun pi-pkm-agenda-title (marker txt state priority tags)
    (when (stringp txt)
      (if (or state priority tags)
          (pi-pkm-agenda-at-marker marker (lambda () (substring-no-properties (org-get-heading t t t t))))
        (substring-no-properties txt))))
  (defun pi-pkm-agenda-todo-state (marker)
    (pi-pkm-agenda-at-marker marker (lambda () (org-element-property :todo-keyword (org-element-at-point)))))
  (defun pi-pkm-agenda-priority (marker)
    (pi-pkm-agenda-at-marker marker
                              (lambda ()
                                (let ((priority (org-element-property :priority (org-element-at-point))))
                                  (when priority (char-to-string priority))))))
  (defun pi-pkm-agenda-date-vector (date)
    (cond
     ((listp date) (vconcat date))
     ((integerp date) (vconcat (calendar-gregorian-from-absolute date)))
     (t nil)))
  (let ((org-agenda-span 7)
        (org-agenda-start-on-weekday 1)
        (org-agenda-use-time-grid t)
        (org-agenda-window-setup 'current-window)
        rows)
    (org-agenda-list nil nil 7)
    (with-current-buffer org-agenda-buffer-name
      (goto-char (point-min))
      (while (not (eobp))
        (let* ((beg (line-beginning-position))
               (end (line-end-position))
               (marker (or (pi-pkm-agenda-line-property 'org-hd-marker beg end)
                           (pi-pkm-agenda-line-property 'org-marker beg end)))
               (category (pi-pkm-agenda-line-property 'org-category beg end))
               (date (pi-pkm-agenda-date-vector (pi-pkm-agenda-line-property 'date beg end)))
               (time (pi-pkm-agenda-line-property 'time beg end))
               (extra (pi-pkm-agenda-line-property 'extra beg end))
               (txt (pi-pkm-agenda-line-property 'txt beg end))
               (state (pi-pkm-agenda-todo-state marker))
               (priority (pi-pkm-agenda-priority marker))
               (tags (pi-pkm-agenda-local-tags marker))
               (title (pi-pkm-agenda-title marker txt state priority tags))
               (file (when (and marker (marker-buffer marker))
                       (buffer-file-name (marker-buffer marker))))
               (line-number (when marker
                              (with-current-buffer (marker-buffer marker)
                                (line-number-at-pos marker)))))
          (when (and marker category date title (stringp time) (string-match-p "[0-9][0-9]?:[0-9][0-9]" time))
            (push (list (cons 'category category)
                        (cons 'date date)
                        (cons 'extra extra)
                        (cons 'file file)
                        (cons 'lineNumber line-number)
                        (cons 'priority priority)
                        (cons 'rawLine (buffer-substring-no-properties beg end))
                        (cons 'state state)
                        (cons 'tags (vconcat (or tags '())))
                        (cons 'time time)
                        (cons 'title title))
                  rows)))
        (forward-line 1)))
    (json-encode (vconcat (nreverse rows)))))`;
}
