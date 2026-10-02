# LaTeX renderer

`render_latex` renders block formulas as images. Inline formulas remain text. Normal assistant messages do not trigger rendering.

```text
render_latex({ markdown: "$$E = mc^2$$", title: "Energy" })
```

Supported forms include `$$...$$`, `\[...\]`, and the `equation`, `align`, `gather`, and `multline` environments.

The default output is a custom message. To render in the tool result instead, use `PI_LATEX_RENDER_MODE=tool pi` or `pi --latex-render-mode tool`.

The renderer requires `latex` and `dvipng` on `PATH`. It caches images in `~/.cache/pi-latex-renderer`.

Run `/latex-renderer-test` in Pi to check rendering.
