# Pi agenda

`pi-pkm` displays tasks in Pi's terminal UI.

- `/org-agenda` or `Alt+X` cycles through the passive agenda, focused pane, and closed state.
- `/org-agenda-refresh` reloads tasks.
- `/org-agenda-done` marks the selected task done.

## Task sources

- `builtin` uses `<project-root>/.pi-pkm/agenda.txt`. It creates the file with a starter task if needed.
- `todo.txt` reads `$TODO_FILE`, then `$TODOTXT_FILE`, then the nearest `todo.txt` above the working directory. Tasks use `due:YYYY-MM-DD` for agenda dates.
- `emacs` reads Org agenda tasks through `emacsclient`. It requires a running Emacs daemon.

All providers support marking tasks done in their source files.

## Pane controls

Use `j`, `k`, or the arrow keys to select tasks. Use `h` and `l` to change the provider filter.

Press `d` to mark a task done, `r` to refresh, or `f` to switch between the widget and footer. Press `Esc` to restore the passive agenda or `q` to close it.
