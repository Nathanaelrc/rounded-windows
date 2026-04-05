#!/usr/bin/env bash
# install.sh – Build and install "Rounded Window Corners" into the user session
#
# Usage:
#   ./install.sh              # compile schema + install extension
#   ./install.sh --uninstall  # remove the extension
#
# Supported distributions:
#   Ubuntu / Debian, Fedora / RHEL, Arch Linux, openSUSE, and any distro
#   with glib-compile-schemas available.

set -euo pipefail

UUID="rounded-windows@marcosgt.github.io"
INSTALL_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colours ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
    GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
    GREEN=''; YELLOW=''; RED=''; NC=''
fi
info()    { echo -e "${GREEN}[✓]${NC} $*"; }
warning() { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ── Uninstall path ────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" ]]; then
    if [[ -d "${INSTALL_DIR}" ]]; then
        rm -rf "${INSTALL_DIR}"
        info "Extension removed from ${INSTALL_DIR}"
    else
        warning "Extension not found at ${INSTALL_DIR}"
    fi
    echo ""
    warning "Reload GNOME Shell to finish (log out or press Alt+F2, type 'r', Enter on X11)."
    exit 0
fi

# ── Dependency check ──────────────────────────────────────────────────────────
if ! command -v glib-compile-schemas &>/dev/null; then
    echo ""
    error "glib-compile-schemas not found. Install it for your distro:

  Ubuntu / Debian:   sudo apt install libglib2.0-bin
  Fedora / RHEL:     sudo dnf install glib2
  Arch Linux:        sudo pacman -S glib2
  openSUSE:          sudo zypper install glib2-tools"
fi

# ── GNOME Shell version check (informational) ────────────────────────────────
if command -v gnome-shell &>/dev/null; then
    GNOME_VER=$(gnome-shell --version 2>/dev/null | grep -oP '\d+' | head -1)
    if [[ -n "${GNOME_VER}" ]]; then
        if (( GNOME_VER < 45 || GNOME_VER > 50 )); then
            warning "GNOME Shell ${GNOME_VER} detected. This extension supports GNOME 45–50."
            warning "It may not work correctly on your version."
        else
            info "GNOME Shell ${GNOME_VER} detected — supported ✓"
        fi
    fi
fi

# ── Compile GSettings schema ──────────────────────────────────────────────────
SCHEMA_DIR="${SCRIPT_DIR}/schemas"
info "Compiling GSettings schema…"
glib-compile-schemas "${SCHEMA_DIR}"
info "  → ${SCHEMA_DIR}/gschemas.compiled"

# ── Create installation directory ────────────────────────────────────────────
mkdir -p "${INSTALL_DIR}/schemas"

# ── Copy extension files ──────────────────────────────────────────────────────
EXTENSION_FILES=(
    metadata.json
    extension.js
    effect.js
    prefs.js
    stylesheet.css
)

for f in "${EXTENSION_FILES[@]}"; do
    src="${SCRIPT_DIR}/${f}"
    if [[ -f "${src}" ]]; then
        cp "${src}" "${INSTALL_DIR}/${f}"
        info "  Copied ${f}"
    else
        error "Required file not found: ${f}"
    fi
done

# ── Copy schema ───────────────────────────────────────────────────────────────
cp "${SCHEMA_DIR}/"*.xml          "${INSTALL_DIR}/schemas/"
cp "${SCHEMA_DIR}/gschemas.compiled" "${INSTALL_DIR}/schemas/"
info "  Copied schemas/"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
info "Extension installed to:"
echo "    ${INSTALL_DIR}"
echo ""
warning "To activate the extension, reload GNOME Shell:"
echo "    • Wayland session:  Log out and log back in"
echo "    • X11 session:      Press Alt+F2, type 'r', press Enter"
echo ""
info "Then enable it with:"
echo "    gnome-extensions enable ${UUID}"
echo ""
info "Or open the Extensions app / GNOME Tweaks → Extensions."
