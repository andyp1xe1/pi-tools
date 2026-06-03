# Pi Extension Lab Goal

We want to explore a richer, more Emacs/org-inspired way to produce and interact with featureful documents and task data. Pi is the first interface we're building it inside, but the long-term shape is a separate program with its own core, and pi as one frontend among several.

The plan is intentionally experimental first, in three rough phases:

1. **Now — pi extensions.** Build small, direct pi extensions in this repo. Use each to test one primitive or interaction pattern (rich rendering, agenda, source blocks, …). Keep notes on what feels good, what is awkward, and what pi's TUI/API can realistically support.
2. **Next — consolidate.** Once enough primitives are proven, architect a coherent rich-document / agenda / PKM system from the experiments.
3. **Later — extract a core.** Lift that system out of `extensions/` into its own program with a well-defined data model and protocol. Pi becomes one interface to that core (probably the primary one for an LLM workflow), but the core should also be usable from a CLI, a web frontend, scripts, or another editor.

The desired end-state is not “random rich output slop.” It is a pi-native document/workspace substrate with an org-like spirit:

- structured reports
- headings and collapsible sections
- LaTeX/math rendering
- source blocks with executable results
- tables
- charts/graphs/images
- TODO/DONE/SCHEDULED/agenda-style blocks
- interactive TUI panes, overlays, selectors, and widgets
- export paths such as HTML, PDF, PNG cards, Markdown, and possibly org-compatible files

Important design stance:

- Emacs-like spirit: yes.
- Org-like syntax/semantics: yes.
- Emacs as a **source** (read agenda/notes from a running Emacs via `emacsclient`, import `.org` files): yes — see the `emacs` provider in `pi-pkm`.
- Emacs as a hard runtime dependency: no — every feature must work with Emacs absent.
- Two-way interop with Emacs/org from inside pi (mark TODO done, reschedule, edit headings, capture a new entry, write `.org` back): yes — the provider contract already reserves `markDone`, and the rest will follow. Pi should be a real client of the data, not a read-only viewer.
- Pi as the only interface: no. The core must stay portable so other frontends (CLI, web, future editors) can plug in and perform the same operations.

Suggested experiments:

## 1. Pane / Overlay Demo

Test pi TUI primitives:

- side panels
- modal overlays
- header/footer widgets
- focus and keyboard handling
- selectors and simple navigation

Goal: understand how far pi can go toward pseudo-windows and interactive panes.

## 2. Rich Document Viewer

Test a small AST renderer with blocks like:

- heading
- paragraph
- math
- code
- result
- table
- callout
- image

Goal: see if pi can render a navigable report-like document cleanly.

## 3. Source Block Runner

Test org-babel-like blocks without Emacs:

- shell/python/js source blocks
- execute block
- cache/attach result
- render output as text/table/image/chart

Goal: validate safe and useful executable document blocks.

## 4. Agenda / TODO Demo

Test org-like task semantics:

- TODO/DONE states
- scheduled/deadline timestamps
- tags/properties
- agenda/sidebar list
- optional calendar interop later

Goal: discover what a pi-native task/agenda workflow should feel like.

## 5. Chart / Graph Block

Test chart rendering:

- simple SVG/PNG chart output
- maybe Vega-Lite later
- render in TUI and export as file

Goal: prove report-like visual output beyond formulas.

## 6. Export Demo

Test converting rich docs into shareable artifacts:

- HTML
- PDF
- PNG/card image
- Markdown/org

Goal: support Telegram/sharing/archival without coupling the design to Telegram.

Current related extensions (the in-pi experiments that will feed the eventual core):

- `latex-renderer/` — `render_latex` tool plus a TUI message renderer that turns block LaTeX into inline PNGs. Validates the "rich block embedded in a chat stream" primitive.
- `pi-pkm/` — agenda widget + pane with a pluggable provider model (`sample`, `emacs`). Currently read-only; next steps include implementing `markDone` and other write-back operations against the emacs provider so pi can act on org entries (close, reschedule, edit) without ever opening Emacs.

Working principle:

Build experiments first. Do not prematurely architect. Once we know the primitives, consolidate them into a coherent rich-document / agenda system inside pi, then extract that system into a standalone core with pi as one of its interfaces.
