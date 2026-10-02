# Agent coordination

- Inside Herdr, load the herdr skill and use sibling panes for delegated agents and long-running jobs. The user need not mention Herdr.
- Keep at most two panes per Herdr tab or tmux window. At the limit, reuse an available pane or work sequentially; do not split again.
- Start Pi agents interactively with saved sessions and visible output. Keep extensions and skills enabled. Use headless or unsaved agents only when the user requests them.
- Preserve the user's focus. Use fresh sessions and read-only tools for independent reviewers.
- When work is done, close panes, tabs, and windows you created after collecting results. Leave unrelated panes and agents alone. Do not stop Herdr.
- Outside Herdr, use tmux if available. Do not control Herdr's session from outside it.
