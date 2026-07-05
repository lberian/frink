# Frink

🇪🇸 [Versión en español](README.es.md)

**Author: Luis Berián «lberian»** · © 2026 · License [GPL-3.0](LICENSE)

> **Frink** = **Fr**eeze + **ink**: freeze what you see and draw ink on top.
> The name is the usage model: *freeze-then-annotate*.

## Why Frink

The person behind this is an **architect and urban planner — with no programming
background**. This is a defining moment for creative people; the paradigm has shifted:
in six months I went from keeping my ideas in a notebook to building projects that
were unthinkable to me. Now I build my own tools for a more fluid interaction. Frink
is both product and proof of that change: a tool made *by conversing* with AI, to
communicate better *with* AI.

Screen-capture tools have spent fifteen years designed to show things to people —
that's why they all end in a bitmap. Frink was born to show things to a **machine
that understands**: every annotation is also exported as **data** — a JSON with the
exact coordinates of every stroke, text, dimension and command. The AI doesn't
interpret your scribble: it *reads* it.

And it works just as well for humans: quick annotations in online meetings while
someone shares their screen.

## Usage

1. **Ctrl+↑** — freezes the screen under your mouse (screen mode).
2. **Ctrl+↓** — sheet mode: a small, movable window opens; drop an image file on it
   and it expands to annotate at full native resolution.
3. **Draw**: pen, highlighter, straight points, spline, rectangle, ellipse (outlined
   or filled), text, eraser, **dimension** (two points + real distance = scale) and
   the ⚡ palette of **commands** (DELETE THIS, PIXELATE, BRIGHTEN, KEEP THIS,
   VANISHING LINE…).
4. **Enter** — exports. Screen mode: the image goes to your clipboard. Sheet mode:
   **both files (PNG + JSON) go to the clipboard** — a single Ctrl+V in your AI chat
   attaches image and data at once.

`Esc` cancels · `Ctrl+Z` undoes · wheel = zoom · space = pan (sheet mode) ·
keys 1-9 for tools · the tray icon lets you pick the output folder and quit.

## What it exports

Same-name pairs in your output folder (default: `Pictures\Frink`):

- `<name>_frink_<date>.png` — the annotated image
- `<name>_frink_<date>.json` — the annotations as data: sub-pixel float coordinates
  of every stroke, texts as text, dimensions with their real length, commands as
  declared instructions, and the path of the original image

## The skill (for Claude)

[`skill/`](skill/) contains the **Frink skill**: it teaches Claude to read the JSON
as geometric ground truth, anchor each annotation to what lies beneath it, turn
dimensions into real-world scale (flat images, or per-plane in perspective scenes),
reconstruct 3D scenes from vanishing points, and translate commands into concrete
tooling (inpainting masks, CAD/GIS data, UI elements). Install it by importing
`skill/frink.skill` into Claude (Settings → Capabilities).

## The MCP connector

Frink ships with an **MCP connector** (`frink_mcp.exe`, built alongside the app)
that gives the AI three powers:

- `frink_latest` / `frink_list` — read your annotations directly, no pasting.
- `frink_annotate(image, prompt)` — **the AI asks you for an annotation**: Frink
  opens on your screen with the image and the AI's question in a banner; you mark it
  up, press Enter, and the pair with exact coordinates comes back (`frink_wait`
  collects the result). The channel stops being one-way.

Register it in Claude Desktop (`claude_desktop_config.json`, then restart Claude):

```json
"mcpServers": {
  "frink": { "command": "C:\\path\\to\\frink_mcp.exe" }
}
```

Everything is 100% local: the connector talks to the app over `127.0.0.1`, and
nothing leaves your machine except what you paste or what the AI asks you for.

## Install

Download `frink.exe` and `frink_mcp.exe` from [Releases](../../releases). No
installation, fully portable (Windows 10/11). Windows SmartScreen will warn about
the unsigned binary: "More info → Run anyway".

### Build from source

[Rust](https://rustup.rs) + `cargo install tauri-cli --version "^2"`, then from
`src-tauri/`:

```bash
cargo tauri build --no-bundle   # produces target/release/frink.exe and frink_mcp.exe
```

No Node, no npm: the frontend is 3 static files using the global Tauri object.

## Structure

```
frink/
├─ src/                      # static frontend (no bundler)
│  ├─ index.html
│  ├─ main.js                # tools, view transform, PNG+JSON export
│  └─ style.css
├─ src-tauri/
│  ├─ src/main.rs            # capture, sheet mode, tray, connector's local API
│  ├─ src/bin/frink_mcp.rs   # MCP connector (stdio) for Claude
│  ├─ Cargo.toml · tauri.conf.json · capabilities/ · icons/
└─ skill/                    # Frink skill for Claude (SKILL.md + frink.skill)
```

## Roadmap

Done: two modes · 9 tools + dimensions + commands · zoom/pan · sub-pixel ·
multi-monitor · tray · configurable output folder · "Open with Frink" · inbox ·
bidirectional MCP connector · skill.

Ideas: local pixelate/blur (privacy before sharing) · brightness/contrast patch ·
background cloning · history index · stable annotation→entity IDs.

---

GPL-3.0 license · for commercial licensing, contact the author.
