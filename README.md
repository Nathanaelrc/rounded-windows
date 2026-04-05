<p align="center">
  <img src="https://img.shields.io/badge/GNOME-45--50-4A86CF?style=flat-square&logo=gnome&logoColor=white" alt="GNOME 45–50">
  <img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square" alt="GPL-3.0">
  <img src="https://img.shields.io/badge/JS-ES2022-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="JavaScript">
</p>

# Rounded Window Corners

A GNOME Shell extension that adds **rounded corners** to all windows — including apps that don't use libadwaita or libhandy (Firefox, VS Code, Chromium, Electron apps, JetBrains IDEs, etc.).

Built with a GLSL fragment shader for hardware-accelerated rendering. No TypeScript build step, no bundler — just vanilla JavaScript.

> Inspired by [rounded-window-corners](https://github.com/yilozt/rounded-window-corners) (yilozt) and [Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners) (flexagoon).

---

## Features

- **Rounded corners** — GLSL fragment shader applied per-window at draw time
- **Squircle / superellipse** — adjustable smoothing (0 = circle, 1 = squircle)
- **Custom shadow** — rounded CSS `box-shadow` replaces GNOME's default rectangular shadow
- **Border** — optional inner or outer coloured border with configurable width
- **Smart detection** — automatically skips libadwaita / libhandy apps to avoid double-rounding
- **Blacklist / Whitelist** — exclude or exclusively include apps by `WM_CLASS`
- **HiDPI & fractional scaling** — correct rendering on multi-monitor and scaled displays
- **Live settings** — all changes apply instantly, no shell restart required

---

## Supported platforms

| Distribution | GNOME Shell | Status |
|:-------------|:------------|:------:|
| Ubuntu 24.04 – 26.04 | 46 – 50 | ✅ |
| Fedora 40 – 44 | 46 – 50 | ✅ |
| Arch Linux (rolling) | 45 – 50 | ✅ |
| Debian Testing / Sid | 45 – 50 | ✅ |
| openSUSE Tumbleweed | 45 – 50 | ✅ |
| Any distro with GNOME 45–50 | 45 – 50 | ✅ |

> **Note:** GNOME 50 is Wayland-only.  On GNOME 45–49 with X11, the extension also works.

---

## Installation

### From source

```bash
git clone https://github.com/Nathanaelrc/rounded-windows.git
cd rounded-windows
```

Install the schema compiler for your distro (if not already present):

```bash
# Ubuntu / Debian
sudo apt install libglib2.0-bin

# Fedora / RHEL
sudo dnf install glib2

# Arch Linux
sudo pacman -S glib2

# openSUSE
sudo zypper install glib2-tools
```

Build and install:

```bash
chmod +x install.sh
./install.sh
```

Reload GNOME Shell, then enable:

```bash
# Wayland: log out and log back in, then:
gnome-extensions enable rounded-windows@marcosgt.github.io

# X11 (GNOME ≤ 49): Alt+F2 → r → Enter, then:
gnome-extensions enable rounded-windows@marcosgt.github.io
```

Or use the **Extensions** app / **Extension Manager** to enable it.

### Uninstall

```bash
./install.sh --uninstall
```

---

## Configuration

Open **Extensions** → **Rounded Window Corners** → ⚙️, or run:

```bash
gnome-extensions prefs rounded-windows@marcosgt.github.io
```

### Corners

| Setting | Description | Default |
|:--------|:------------|:--------|
| Radius | Corner radius in pixels | `12` |
| Smoothing | `0` = circle, `1` = squircle (superellipse) | `0.6` |
| Clip padding | Gap between window edge and clip boundary | `1` |
| Border width | Positive = inner border, negative = outer | `0` |
| Border colour | RGBA colour picker | — |

### Shadow

| Setting | Description | Default |
|:--------|:------------|:--------|
| Custom shadow | Enable the rounded box-shadow | `on` |
| Focused | Opacity, blur, spread, x/y offset | — |
| Unfocused | Separate settings for unfocused windows | — |

### Applications

| Setting | Description | Default |
|:--------|:------------|:--------|
| Skip libadwaita | Don't round apps that already have rounded corners | `on` |
| Skip libhandy | Same, for legacy Handy apps | `on` |
| Exception list | `WM_CLASS` names to blacklist (or whitelist) | — |
| Whitelist mode | Treat the exception list as a whitelist | `off` |

---

## How it works

```
Window Actor
  └─ RoundedCornersEffect (Shell.GLSLEffect)
        └─ GLSL fragment shader → discards fragments outside the rounded rect
                                → antialiases the 1px edge band

Shadow Actor (St.Bin, below window in global.windowGroup)
  └─ ClipShadowEffect (Shell.GLSLEffect)
        └─ GLSL fragment shader → clips shadow inside the window bounds
  └─ Inner St.Bin → CSS border-radius + box-shadow
```

The extension attaches a `Shell.GLSLEffect` to each window's `Clutter.Actor`. The fragment shader receives the window bounds, corner radius, and smoothing exponent as uniforms, then discards any fragment outside the rounded rectangle. Antialiasing is done by blending alpha over a 1px band at the edge.

A custom shadow is a separate `St.Bin` positioned below each window actor with CSS `border-radius` and `box-shadow`, clipped by a second GLSL effect to prevent shadow from showing inside the window.

---

## Project structure

```
rounded-windows/
├── metadata.json          Extension manifest (UUID, shell versions)
├── extension.js           Main class: window tracking, signals, shadow management
├── effect.js              GLSL effects: RoundedCornersEffect, ClipShadowEffect
├── prefs.js               Preferences UI (GTK4 + libadwaita)
├── stylesheet.css          Shell-side CSS for shadow actors
├── schemas/
│   └── *.gschema.xml      GSettings schema (30+ keys)
├── install.sh             Build & install script (multi-distro)
├── LICENSE                GPL-3.0
└── README.md
```

---

## Troubleshooting

### Extension crashes GNOME Shell
Check the journal for errors:
```bash
journalctl -b /usr/bin/gnome-shell | grep -E "rounded-windows|signal 11|JS ERROR"
```

### Corners look wrong on HiDPI / fractional scaling
The extension detects `scale-monitor-framebuffer` automatically. If corners still look off, try adjusting the **clip padding** in settings.

### No effect on some apps
Some apps (libadwaita/libhandy) are skipped by default. Disable **Skip libadwaita** in settings, or add the app's `WM_CLASS` to the whitelist. Find a window's class with:
```bash
# Wayland
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "global.get_window_actors().map(a => a.metaWindow.get_wm_class_instance()).join('\\n')"
```

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Commit your changes (`git commit -m "feat: description"`)
4. Push and open a Pull Request

---

## Credits

- **Fragment shader** — based on [Mutter's background shader](https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/compositor/meta-background-content.c)
- **Original extension** — [yilozt/rounded-window-corners](https://github.com/yilozt/rounded-window-corners) (archived)
- **Active fork** — [flexagoon/rounded-window-corners](https://github.com/flexagoon/rounded-window-corners) (Rounded Window Corners Reborn)

---

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
