# Pi Extension Lab Goal

We want to explore a richer, more Emacs/org-inspired way for pi to produce and interact with featureful documents, without depending on Emacs as the runtime.

The plan is intentionally experimental first:

1. Build small, direct pi extensions in `~/.pi/agent/extensions/`.
2. Use each extension to test one primitive or interaction pattern.
3. Keep notes on what feels good, what is awkward, and what pi's TUI/API can realistically support.
4. Only after enough experiments, architect a coherent rich-document/org-like system from the proven ideas.

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
- Emacs as a hard dependency: no.
- Emacs/org-mode interop as an optional backend/import/export path: maybe later.

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

Current related extension:

- `latex-renderer/` implements `render_latex`, a focused LaTeX block renderer for pi TUI/custom messages. It is a useful primitive, but not the final rich-doc architecture.

Working principle:

Build experiments first. Do not prematurely architect. Once we know the primitives, consolidate into a coherent pi-native rich document system.
