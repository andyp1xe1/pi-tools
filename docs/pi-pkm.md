# pi pkm

An experimental org-style **agenda pane** inside pi's TUI — a step toward a pi-native PKM/document substrate (see [`docs/GOAL.md`](./GOAL.md)).

## What you get

- `/org-agenda` — slash command that cycles the agenda: open passive widget → focus full pane → close.
- `/org-agenda-refresh` — reload enabled agenda providers and redraw the passive agenda if it is open.
- `/org-agenda-done` — mark the currently selected agenda item `DONE` when its provider supports write-back.
- `Alt+X` — shortcut bound to the same cycle.
- A pluggable provider model so the agenda can be fed from different backends without the TUI knowing the difference.

## Agenda model

Items have the shape (see `src/pi-pkm/agenda/types.ts`):

- `state` — `TODO` / `DONE` / `WAIT`
- `priority` — `A` / `B` / `C`
- `day` — integer offset from today (0 = today, 1 = tomorrow, …)
- `time` / `timeRange` — `HH:MM` or `HH:MM-HH:MM`
- `tags`, `source`, `file`, `line`, `raw`

The renderer (`src/pi-pkm/agenda/renderer.ts`) draws the widget and full pane; the store (`src/pi-pkm/agenda/store.ts`) merges results from all enabled providers and tracks which provider filter is active.

## Providers

Three are wired up by default:

### `builtin`

Project-local native persistence backed by pi-pkm's built-in agenda format. The provider looks upward from pi's current working directory for the nearest Git repository; if it finds one, it uses that repo root, otherwise it uses the current working directory. The agenda file lives at:

```text
<project-root>/.pi-pkm/agenda.txt
```

If the file does not exist, pi-pkm creates it with a commented format header and one starter item. Supported lines look like:

```text
TODO 2026-06-04 09:00 [#B] Add your first project agenda item +pi @work
WAIT 2026-06-05 14:00 Follow up on renderer API +pi
DONE 2026-06-06 10:30 Ship agenda persistence +pkm
```

States are `TODO`, `WAIT`, and `DONE`; priority is optional (`[#A]`, `[#B]`, `[#C]`); tags can be `+tag` or `@context`. Marking an item done rewrites that line in place.

Source: `src/pi-pkm/agenda/providers/builtin.ts`.

### `todo.txt`

Reads a standard todo.txt file without taking ownership of it. The provider looks for a file in this order:

1. `$TODO_FILE`
2. `$TODOTXT_FILE`
3. the nearest `todo.txt` found by walking upward from pi's current working directory

Supported lines are normal todo.txt entries, for example:

```text
(A) 2026-06-04 Call Bob +work @phone due:2026-06-05
x 2026-06-06 2026-06-04 Finished task +work due:2026-06-06
```

Agenda placement uses `due:YYYY-MM-DD`; completed items without `due:` fall back to their completion date. `+project` and `@context` become agenda tags. Marking an item done rewrites that line in place using the standard `x YYYY-MM-DD ...` completion prefix and removes a leading active priority.

Source: `src/pi-pkm/agenda/providers/todo-txt.ts`.

### `emacs`

Shells out to `emacsclient --eval <elisp>` and parses a JSON agenda payload back. Useful if you already keep org files in Emacs and want pi to read the same agenda you'd see in `M-x org-agenda`.

Requirements:

- A running Emacs daemon reachable via `emacsclient`.
- An elisp function (invoked by the provider) that returns the agenda as a JSON string of rows with `category`, `date: [m, d, y]`, `time`, `state`, `priority`, `tags`, `title`, `file`, `lineNumber`, `rawLine`.

Source: `src/pi-pkm/agenda/providers/emacs.ts`. `markDone` uses the agenda row's file/line marker, calls `org-todo "DONE"`, and saves the buffer through `emacsclient`.

### Adding your own

Implement `AgendaProvider` (`id`, `label`, `listAgenda`, `markDone`) and register it in `src/pi-pkm/agenda/store.ts`. The store handles filtering (`all` or by `provider.id`) and error display.

## Fixture

`fixtures/org/pi-pkm-rich-test.org` is a small org file with SCHEDULED, DEADLINE, tags, source blocks, and a DONE entry — handy for sanity-checking parsing in an Emacs setup.

## Pane controls

Inside the focused agenda pane:

- `j` / `k` or arrows — move selection
- `h` / `l` — cycle provider filter
- `d` — mark selected item done
- `r` — refresh providers
- `f` — toggle passive surface (`widget` / `footer`)
- `g` / `G` — first / last item
- `Esc` — restore passive agenda
- `q` or `Alt+X` — close agenda

## Status

This is **experimental**. The plan (per `docs/GOAL.md`) is to build small, direct extensions like this one, test specific primitives, and only later architect a coherent rich-document substrate from the proven ideas. Expect the API and provider contract to shift.

## Smoke test

```bash
pi --no-session --no-tools --offline -e ./extensions/pi-pkm.ts -p /org-agenda
```

The `builtin` provider is always available, so this works without Emacs and will create `.pi-pkm/agenda.txt` in the current project if needed. If a standard `todo.txt` is present nearby, the `todo.txt` provider will include due items from it too.

## Source

- `extensions/pi-pkm.ts` (re-exports `src/pi-pkm/index.ts`)
- `src/pi-pkm/agenda/`
