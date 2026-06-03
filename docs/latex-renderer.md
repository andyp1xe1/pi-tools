# pi LaTeX renderer

Simple intentional LaTeX rendering extension for pi.

It registers a `render_latex` tool. The model can call this tool when it wants to display a clean math-heavy/rich answer.

Behavior:

- No automatic rendering for normal assistant messages.
- Inline formulas are ignored by the renderer and left as normal Markdown text.
- Block formulas are removed from the text view and rendered as images at that position.
- Images render at natural size and only shrink if too large, so small formulas should not become huge/blurry.
- PNG foreground comes from `FORMULA_COLOR` in `src/config.ts`. Use a theme key like `muted`, or a direct hex value like `#bdae93`. `customMessageText`/`text` are often terminal-default aliases, which cannot be converted to a PNG RGB color.
- Output mode is configurable:
  - `message` (default): render as a custom message via `pi.sendMessage()`.
  - `tool`: render directly in the tool result row.

Configure with either:

```bash
PI_LATEX_RENDER_MODE=tool pi
pi --latex-render-mode tool
```

Use `message` to return to the default:

```bash
PI_LATEX_RENDER_MODE=message pi
pi --latex-render-mode message
```

Rendered block forms:

- `$$...$$`
- `\[...\]`
- `\begin{equation}...\end{equation}` / `equation*`
- `\begin{align}...\end{align}` / `align*`
- `\begin{gather}...\end{gather}` / `gather*`
- `\begin{multline}...\end{multline}` / `multline*`

Cache: `~/.cache/pi-latex-renderer`

Development:

```bash
npm install
npm run check
npm run fix
```

Formatting/linting uses the local `@biomejs/biome` dev dependency from `package.json`; no global formatter/linter is required.

The renderer shells out to `latex` and `dvipng`, so those need to be available on PATH (provided by the `texlive` and `dvipng` nixpkgs attributes on NixOS).

Reload pi after changes:

```text
/reload
```

Test:

```text
/latex-renderer-test
```
