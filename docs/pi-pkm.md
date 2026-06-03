# pi pkm

An experimental org-style **agenda pane** inside pi's TUI — a step toward a pi-native PKM/document substrate (see [`docs/GOAL.md`](./GOAL.md)).

## What you get

- `/org-agenda` — slash command that cycles the agenda: open passive widget → focus full pane → close.
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

Two are wired up by default:

### `sample`

Hard-coded fixture items, useful for testing the renderer with no external state. Source: `src/pi-pkm/agenda/providers/sample.ts`.

### `emacs`

Shells out to `emacsclient --eval <elisp>` and parses a JSON agenda payload back. Useful if you already keep org files in Emacs and want pi to read the same agenda you'd see in `M-x org-agenda`.

Requirements:

- A running Emacs daemon reachable via `emacsclient`.
- An elisp function (invoked by the provider) that returns the agenda as a JSON string of rows with `category`, `date: [m, d, y]`, `time`, `state`, `priority`, `tags`, `title`, `file`, `lineNumber`, `rawLine`.

Source: `src/pi-pkm/agenda/providers/emacs.ts`. `markDone` is reserved but not implemented yet.

### Adding your own

Implement `AgendaProvider` (`id`, `label`, `listAgenda`, optional `markDone`) and register it in `src/pi-pkm/agenda/store.ts`. The store handles filtering (`all` or by `provider.id`) and error display.

## Fixture

`fixtures/org/pi-pkm-rich-test.org` is a small org file with SCHEDULED, DEADLINE, tags, source blocks, and a DONE entry — handy for sanity-checking parsing in an Emacs setup.

## Status

This is **experimental**. The plan (per `docs/GOAL.md`) is to build small, direct extensions like this one, test specific primitives, and only later architect a coherent rich-document substrate from the proven ideas. Expect the API and provider contract to shift.

## Smoke test

```bash
pi --no-session --no-tools --offline -e ./extensions/pi-pkm.ts -p /org-agenda
```

The `sample` provider is always available, so this works without Emacs.

## Source

- `extensions/pi-pkm.ts` (re-exports `src/pi-pkm/index.ts`)
- `src/pi-pkm/agenda/`
