# pi-pkm agenda/provider plan

## Context

The current pi-pkm agenda is useful as a TUI surface, but provider semantics need to be clearer. During this session we separated the pi-native provider from real todo.txt support and discussed how to make the system workable across multiple backends.

## Provider naming and ownership

### Builtin provider

- The pi-native/default provider should be named `builtinProvider`.
- It should not be called `todo.txt`, because its syntax is not standard todo.txt and is not org-mode compatible.
- It is pi-pkm's owned format and can evolve freely.
- Current storage path:

```text
<project-root>/.pi-pkm/agenda.txt
```

- Current syntax:

```text
TODO 2026-06-04 09:00 [#B] Add your first project agenda item +pi @work
WAIT 2026-06-05 14:00 Follow up on renderer API +pi
DONE 2026-06-06 10:30 Ship agenda persistence +pkm
```

- Longer-term, this provider could migrate to SQLite or a richer pi-native document/task substrate.

### todo.txt provider

- Standard todo.txt support should be a separate provider.
- It should support todotxt.org / `todo.sh`-style lines, for example:

```text
(A) 2026-06-04 Call Bob +work @phone due:2026-06-05
x 2026-06-06 2026-06-04 Finished task +work due:2026-06-06
```

- It should not use the builtin syntax.
- It can start as a native file parser/writer.
- Later, optionally add a `todo.sh` backend for users who already rely on todo.txt-cli behavior, config, and add-ons.

### External providers

Examples:

- Emacs/org-mode via `emacsclient`
- GitHub issues
- Linear/Jira
- calendar/reminders
- email follow-ups

These providers should expose the same UI projection but keep their own source-of-truth semantics.

## Current todo.txt provider scope

The todo.txt provider added in this session currently supports:

- finding a file via:
  1. `$TODO_FILE`
  2. `$TODOTXT_FILE`
  3. nearest `todo.txt` by walking upward from pi's cwd
- parsing active tasks with `(A)` / `(B)` / `(C)` priorities
- parsing completed tasks with `x YYYY-MM-DD ...`
- mapping `due:YYYY-MM-DD` to agenda placement
- using completed date as fallback agenda date for completed tasks without `due:`
- mapping `+project` and `@context` to agenda tags
- marking a task done by rewriting it as `x <today> ...`

Missing todo.txt features:

- task creation
- edit/delete/archive
- priority mutation
- project/context-specific filtering
- due-date editing/rescheduling
- recurrence via `rec:`
- threshold/start dates via `t:`
- atomic writes/locking
- `done.txt` archive support
- discovery from `~/.todo/config`
- optional `todo.sh` integration

This is enough for basic agenda display + mark-done, but not yet a full todo.txt app.

## Common provider interface

A common interface can work, but it should be capability-based. Do not assume every provider supports every operation.

Sketch:

```ts
interface AgendaProvider {
  id: string;
  label: string;

  listAgenda(query: AgendaQuery): Promise<AgendaItem[]>;

  capabilities: {
    create?: boolean;
    markDone?: boolean;
    editTitle?: boolean;
    reschedule?: boolean;
    setPriority?: boolean;
    setState?: boolean;
    delete?: boolean;
    archive?: boolean;
    addTag?: boolean;
    removeTag?: boolean;
  };

  create?(input: CreateAgendaItem): Promise<AgendaMutationResult>;
  markDone?(item: AgendaItem): Promise<AgendaMutationResult>;
  editTitle?(item: AgendaItem, title: string): Promise<AgendaMutationResult>;
  reschedule?(item: AgendaItem, when: AgendaDateTime): Promise<AgendaMutationResult>;
  setPriority?(item: AgendaItem, priority?: AgendaPriority): Promise<AgendaMutationResult>;
  setState?(item: AgendaItem, state: AgendaItemState): Promise<AgendaMutationResult>;
  delete?(item: AgendaItem): Promise<AgendaMutationResult>;
}
```

The UI should enable/disable commands based on provider capabilities and show a friendly message when an operation is unsupported.

## Canonical UI model

A canonical UI model can exist, but only as a projection / lowest-common-denominator model. It should be good enough for display, sorting, filtering, and generic actions, while preserving provider-native raw data.

Sketch:

```ts
interface AgendaItem {
  id: string;
  providerId: string;

  title: string;
  state?: "TODO" | "WAIT" | "DONE" | string;
  priority?: "A" | "B" | "C" | string;

  start?: Date;
  end?: Date;
  due?: Date;
  scheduled?: Date;

  tags: string[];
  source?: string;

  file?: string;
  line?: number;

  raw?: unknown;
  metadata?: Record<string, unknown>;
}
```

Important distinction:

- `AgendaItem` is what pi needs to render and act on.
- The provider remains the source of truth.
- Provider-specific fidelity belongs in `raw` / `metadata`, not in an overcomplicated universal schema.

## Semantic mapping examples

| UI operation | builtin | todo.txt | org/emacs |
|---|---|---|---|
| list agenda | parse `.pi-pkm/agenda.txt` | parse `todo.txt` | query org-agenda via Emacs |
| mark done | rewrite `TODO`/`WAIT` to `DONE` | add `x YYYY-MM-DD` prefix | `org-todo DONE` |
| reschedule | rewrite date/time | rewrite `due:` | rewrite `SCHEDULED`/`DEADLINE` |
| priority | `[#A]` | `(A)` | `[#A]` |
| tags | `+tag` / `@context` | `+project` / `@context` | `:tag:` |
| archive | future builtin behavior | `done.txt` or `todo.sh archive` | org archive subtree |

## UI direction

The agenda UI can remain provider-neutral if it is built around:

1. listing agenda items from all providers
2. showing provider filters: `all`, `builtin`, `todo.txt`, `emacs`, etc.
3. exposing generic actions only when supported
4. delegating serialization and write-back to the selected item's provider

Near-term commands worth adding after the interface is capability-based:

- create item
- edit title/body
- reschedule/due date edit
- set priority
- delete
- archive
- add/remove tag

## Nix/deployment note

When adding new provider files, they must be committed for Nix flakes/path inputs to include them reliably. After committing changes in `pi-tools`, update the consuming config's flake lock and reactivate/rebuild Home Manager so pi points at the new Nix store path.
