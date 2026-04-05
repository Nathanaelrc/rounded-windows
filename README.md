# Rounded Window Corners

A GNOME Shell extension that adds **rounded corners** to every window,
including apps that do not use libadwaita or libhandy (Firefox, VS Code,
Chromium, JetBrains IDEs, etc.).

Inspired by and based on the algorithm from
[rounded-window-corners](https://github.com/yilozt/rounded-window-corners)
(yilozt, no longer maintained) and
[Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners)
(flexagoon, GNOME 46+).

This rewrite targets **GNOME 45 – 50** (Ubuntu 24.04 → 26.04) and is written
entirely in vanilla JavaScript (no TypeScript build step).

---

## Features

| Feature | Details |
|---------|---------|
| 🟣 Rounded corners | GLSL fragment shader, applies to **all** window types |
| 🔵 Squircle shape | Adjustable super-ellipse smoothing (0 = circle → 1 = squircle) |
| 🟠 Custom shadow | Rounded CSS box-shadow replaces the rectangular GNOME shadow |
| 🟡 Border | Optional inner / outer coloured border |
| ⚙️  Per-app skip | Automatically skips libadwaita / libhandy apps |
| 📋 Blacklist/whitelist | Exclude or exclusively include apps by WM class |
| 🖥️ HiDPI aware | Correct scaling on multi-monitor setups |
| 🔄 Live settings | Changes apply instantly without restarting the shell |

---

## Requirements

| Dependency | Version |
|-----------|---------|
| GNOME Shell | 45 – 50 |
| Ubuntu | 24.04 LTS – 26.04 LTS |
| `glib-compile-schemas` | Provided by `libglib2.0-bin` |

---

## Installation

### From source (recommended)

```bash
# 1. Clone the repository
git clone https://github.com/marcosgt/rounded-windows
cd rounded-windows

# 2. Install dependency (Ubuntu / Debian)
sudo apt install libglib2.0-bin   # provides glib-compile-schemas

# 3. Build and install
chmod +x install.sh
./install.sh

# 4. Reload GNOME Shell
#    Wayland  → log out and log in again
#    X11      → Alt + F2, type 'r', Enter

# 5. Enable the extension
gnome-extensions enable rounded-windows@marcosgt.github.io
```

Or use **GNOME Extensions** app / **GNOME Tweaks → Extensions** to enable it.

### Uninstall

```bash
./install.sh --uninstall
```

---

## Configuration

Open **Extensions** → **Rounded Window Corners** → ⚙️ Settings, or run:

```bash
gnome-extensions prefs rounded-windows@marcosgt.github.io
```

### Pages

#### Corners
- **Radius** – corner radius in pixels (default 12)
- **Smoothing** – 0 = perfect circle, 1 = squircle/super-ellipse (default 0.6)
- **Clip padding** – gap between the window edge and the clip boundary
- **Border** – width (positive = inner, negative = outer), colour

#### Shadow
- **Custom shadow** – enable/disable the rounded CSS shadow
- **Focused / Unfocused** – separate opacity, blur, spread, offset settings

#### Applications
- **Skip libadwaita** / **Skip libhandy** – avoid double-rounding native apps
- **Exception list** – WM class names to skip (or exclusively include)
- **Whitelist mode** – flip the exception list to a whitelist

---

## How it works

GNOME Shell windows are rendered as
[Clutter](https://docs.gtk.org/clutter/) actors.  This extension attaches a
`Shell.GLSLEffect` to each window actor that runs a GLSL fragment shader
(`effect.js`) at draw time.

The shader receives the window bounds and corner radius as uniforms and
discards any fragment that falls outside the rounded rectangle.  Anti-aliasing
is achieved by smoothly blending the alpha channel over a 1-pixel band at the
edge.

The optional custom shadow is a separate `St.Bin` widget positioned below each
window actor in `global.windowGroup`.  Its inner child is styled with CSS
`border-radius` and `box-shadow`, giving a correctly rounded drop shadow.

---

## Project structure

```
rounded-windows/
├── metadata.json          Extension manifest
├── extension.js           Main extension class + window management
├── effect.js              GLSL effects (RoundedCornersEffect, ClipShadowEffect)
├── prefs.js               Preferences UI (GTK4 / libadwaita)
├── stylesheet.css         Shell-side CSS (shadow actor style)
├── schemas/
│   └── org.gnome.shell.extensions.rounded-windows.gschema.xml
├── install.sh             Build & install helper
├── LICENSE                GPL-3.0
└── README.md
```

---

## Credits

- **Fragment shader algorithm** –
  [Mutter background shader](https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/compositor/meta-background-content.c)
- **Original extension** – [yilozt/rounded-window-corners](https://github.com/yilozt/rounded-window-corners)
- **Active fork** – [flexagoon/rounded-window-corners](https://github.com/flexagoon/rounded-window-corners)
  (Rounded Window Corners Reborn)

---

## License

GPL-3.0 – see [LICENSE](LICENSE).
