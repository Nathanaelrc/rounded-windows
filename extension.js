/**
 * extension.js – Rounded Window Corners
 *
 * Applies GLSL-based rounded corners (and an optional custom shadow) to every
 * window that is not already drawn with libadwaita / libhandy.
 *
 * Signal / lifecycle flow
 * ──────────────────────
 * enable()
 *   └─ wait for shell startup → enableEffect()
 *        ├─ connect global signals   (window-created, minimize, unminimize,
 *        │                            destroy, restacked, settings changed)
 *        └─ applyEffectTo() every existing window actor
 *
 * applyEffectTo(actor)
 *   ├─ connect per-window signals  (size, texture size, fullscreen, focus,
 *   │                               workspace-changed)
 *   └─ onAddEffect(actor)
 *        ├─ add RoundedCornersEffect to the actor / surface
 *        ├─ create custom shadow St.Bin (below the actor in windowGroup)
 *        └─ refreshRoundedCorners()
 *
 * disable()
 *   ├─ disableEffect()    → removeEffectFrom() every actor
 *   └─ uninitPrefs()
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { RoundedCornersEffect, ClipShadowEffect } from './effect.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const ROUNDED_CORNERS_EFFECT = 'rwc-rounded-corners';
const CLIP_SHADOW_EFFECT      = 'rwc-clip-shadow';
const SHADOW_PADDING          = 22;   // extra pixels around the shadow actor

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
//   _settings  – Gio.Settings instance (populated by enable())
//   _connections – list of { object, id } for global signal connections
//   _actorMap    – WeakMap<Meta.WindowActor, ActorData>
//
// ActorData = {
//   shadow         : St.Bin | null,
//   propertyBindings: GObject.Binding[],
//   timeoutId      : GLib.Source | 0,
// }
// ─────────────────────────────────────────────────────────────────────────────
let _settings       = null;
let _connections    = [];   // global connections
const _actorMap     = new WeakMap();
let _mutterSettings = null;
let _fractionalScaling = null;

// ─────────────────────────────────────────────────────────────────────────────
// Settings helpers
// ─────────────────────────────────────────────────────────────────────────────
function getS(key)   { return _settings.get_value(key).recursiveUnpack(); }
function getB(key)   { return _settings.get_boolean(key); }
function getI(key)   { return _settings.get_int(key); }
function getD(key)   { return _settings.get_double(key); }

/** Build the per-window config object from GSettings. */
function buildConfig() {
    return {
        cornerRadius: getI('corner-radius'),
        smoothing:    getD('smoothing'),
        padding: {
            top:    getI('padding-top'),
            bottom: getI('padding-bottom'),
            left:   getI('padding-left'),
            right:  getI('padding-right'),
        },
        borderWidth: getI('border-width'),
        borderColor: [
            getD('border-red'),
            getD('border-green'),
            getD('border-blue'),
            getD('border-alpha'),
        ],
        keepRoundedMaximized:  getB('keep-rounded-maximized'),
        keepRoundedFullscreen: getB('keep-rounded-fullscreen'),
    };
}

/** Return the shadow settings for the focused or unfocused state. */
function shadowConfig(focused) {
    const prefix = focused ? 'focused-shadow' : 'unfocused-shadow';
    return {
        opacity:         getI(`${prefix}-opacity`),
        blur:            getI(`${prefix}-blur`),
        spread:          getI(`${prefix}-spread`),
        xOffset:         getI(`${prefix}-x-offset`),
        yOffset:         getI(`${prefix}-y-offset`),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────
function logDbg(msg) {
    if (_settings && getB('debug-mode'))
        console.log(`[RoundedWindows] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Application type detection  (libadwaita / libhandy)
// ─────────────────────────────────────────────────────────────────────────────
const _appTypeCache = new Map();   // pid ↦ 'LibAdwaita' | 'LibHandy' | 'Other'

function getAppType(win) {
    const pid = win.get_pid();
    if (_appTypeCache.has(pid))
        return _appTypeCache.get(pid);

    let type = 'Other';
    try {
        const decoder = new TextDecoder();
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/maps`);
        const maps = decoder.decode(bytes);
        if (maps.includes('libadwaita-1.so'))
            type = 'LibAdwaita';
        else if (maps.includes('libhandy-1.so'))
            type = 'LibHandy';
    } catch (_) {
        // /proc may not be readable for all pids – treat as 'Other'
    }

    _appTypeCache.set(pid, type);
    return type;
}

/** True when this window should NOT get rounded corners. */
function shouldSkip(win) {
    // DING (Desktop Icons NG) desktop pseudo-window
    // gtkApplicationId is a property in GJS (not a method)
    try {
        const appId = win.gtkApplicationId ?? win.get_gtk_application_id?.();
        if (appId === 'com.rastersoft.ding') return true;
    } catch (_) {}

    const wmClass = win.get_wm_class_instance();
    if (!wmClass)
        return true;   // null or empty string – not yet initialised

    // Only process normal application windows
    const normalTypes = [
        Meta.WindowType.NORMAL,
        Meta.WindowType.DIALOG,
        Meta.WindowType.MODAL_DIALOG,
    ];
    if (!normalTypes.includes(win.windowType))
        return true;

    // Blacklist / whitelist logic:
    //   Normal mode (whitelist-mode = false):
    //     listed windows are EXCLUDED (blacklist)
    //   Whitelist mode (whitelist-mode = true):
    //     only listed windows are INCLUDED, all others are excluded
    const blacklist     = getS('blacklist');
    const whitelistMode = getB('whitelist-mode');
    const isListed      = blacklist.includes(wmClass);

    if (whitelistMode && !isListed)
        return true;   // whitelist mode: skip apps not in the list
    if (!whitelistMode && isListed)
        return true;   // blacklist mode: skip apps in the list

    // Optionally skip libadwaita / libhandy apps (unless explicitly listed)
    const appType = getAppType(win);
    if (getB('skip-libadwaita-app') && appType === 'LibAdwaita' && !isListed)
        return true;
    if (getB('skip-libhandy-app')   && appType === 'LibHandy'   && !isListed)
        return true;

    // Skip maximised / fullscreen windows unless the user explicitly wants
    // rounded corners in those states
    const cfg = buildConfig();
    const isMax  = win.maximizedHorizontally || win.maximizedVertically;
    const isFull = win.fullscreen;

    if (isMax  && !cfg.keepRoundedMaximized)  return true;
    if (isFull && !cfg.keepRoundedFullscreen) return true;

    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actor helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the Clutter.Actor to which the rounded-corners effect should be applied.
 *
 * The decision depends on whether the X11 window has a WM (server-side) frame:
 *
 * • Wayland-native windows: effect on the WindowActor itself.
 *
 * • X11/XWayland WITH a WM frame (e.g. VirtualBox, OBS, Qt apps, GTK2 apps):
 *   `win.decorated` is true.  The WM frame (title bar, borders) is composited
 *   into the WindowActor together with the client area.  We must apply the
 *   effect to the WindowActor so that the shader rounds the full visible frame,
 *   not just the raw client surface.
 *
 * • X11/XWayland WITHOUT a WM frame (undecorated apps — Electron with
 *   frame:false, some games, custom-chrome apps …):
 *   `win.decorated` is false.  Mutter still draws its own compositor shadow on
 *   the WindowActor, which bleeds into the outermost FBO pixels as a
 *   transparent fringe.  To avoid that artefact we apply the effect to the
 *   *first child* (MetaSurfaceActor), which contains only the window surface —
 *   beyond the reach of Mutter's compositor shadow.
 */
function targetActor(actor) {
    const win = actor.metaWindow;
    if (!win) return actor;

    if (win.get_client_type() !== Meta.WindowClientType.X11)
        return actor;   // Wayland native

    // X11: `win.decorated` is true when Mutter draws a server-side frame
    // (title bar, borders) around the window.
    if (win.decorated)
        return actor;   // WM-decorated X11: effect on the full WindowActor

    // Undecorated X11 (Electron with frame:false, etc.):
    // apply to the surface child to keep Mutter's shadow out of the FBO.
    return actor.get_first_child() ?? actor;
}

/** Get the RoundedCornersEffect attached to a window actor (or null). */
function getEffect(actor) {
    const target = targetActor(actor);
    return target ? target.get_effect(ROUNDED_CORNERS_EFFECT) : null;
}

/**
 * Check whether fractional scaling is enabled.
 * When `scale-monitor-framebuffer` is active (default on GNOME 46+ Wayland),
 * the compositor handles scaling at the buffer level and the actor/FBO
 * dimensions already account for the scale.  Returning the raw monitor
 * scale in that case would double-scale all shader values.
 */
function isFractionalScalingEnabled() {
    if (_fractionalScaling !== null)
        return _fractionalScaling;

    try {
        if (!_mutterSettings)
            _mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });

        const features = _mutterSettings.get_strv('experimental-features');
        const isWayland = !Meta.is_wayland_compositor || Meta.is_wayland_compositor();
        _fractionalScaling = isWayland && features.includes('scale-monitor-framebuffer');
    } catch (_) {
        _fractionalScaling = false;
    }
    return _fractionalScaling;
}

/** Get the monitor scale factor for a window (respects fractional scaling). */
function scaleFactor(win) {
    // When fractional scaling is enabled the actor dimensions already
    // incorporate the scale, so the shader must use scale = 1.
    if (isFractionalScalingEnabled())
        return 1;

    const idx = win.get_monitor();
    return global.display.get_monitor_scale(idx);
}

/**
 * Compute the offset between the window's buffer rect and its frame rect.
 * CSD windows have invisible resize grips outside the visible frame; this
 * delta lets us clip only the visible part.
 *
 * Returns [dx, dy, dw, dh] (all ≤ 0 for the width/height components).
 */
function contentOffset(win) {
    const buf   = win.get_buffer_rect();
    const frame = win.get_frame_rect();
    return [
        frame.x - buf.x,
        frame.y - buf.y,
        frame.width  - buf.width,
        frame.height - buf.height,
    ];
}

/**
 * Compute the shader bounds (x1, y1, x2, y2) in *target-actor-local* pixel
 * coords.  The target actor is determined by targetActor().
 *
 * Three cases:
 *
 * 1. Wayland-native   → target = WindowActor.
 *    Apply the buffer/frame contentOffset to skip invisible CSD resize grips.
 *
 * 2. X11 WITH WM frame → target = WindowActor.
 *    Same as Wayland: the frame+client area is already the full actor size.
 *    No inset needed — the WM frame pixels are clean.
 *
 * 3. X11 WITHOUT WM frame / undecorated (win.decorated === false) →
 *    target = first_child.  The surface starts at (0,0) in its own
 *    coordinate space.  Apply a 1px inset to hide the outermost FBO texels,
 *    which can be partially transparent due to Mutter's compositor shadow
 *    on the parent WindowActor leaking in via sub-pixel anti-aliasing.
 */
function computeBounds(actor) {
    const win = actor.metaWindow;

    if (win.get_client_type() === Meta.WindowClientType.X11) {
        if (!win.decorated) {
            // Case 3: undecorated X11 (Electron with frame:false …) — target is first_child.
            const sc    = scaleFactor(win);
            const child = actor.get_first_child();
            const w     = child ? child.width  : actor.width;
            const h     = child ? child.height : actor.height;
            return { x1: sc, y1: sc, x2: w - sc, y2: h - sc };
        }
        // Case 2: WM-decorated X11 — target is WindowActor, same as Wayland.
    }

    // Case 1 & 2: target is the WindowActor itself.
    const [dx, dy, dw, dh] = contentOffset(win);
    return {
        x1: dx,
        y1: dy,
        x2: dx + actor.width  + dw,
        y2: dy + actor.height + dh,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadow helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build the CSS box-shadow string from a shadow config object. */
function boxShadowCss(sc, scale) {
    const alpha  = (sc.opacity / 255).toFixed(3);
    const blur   = (sc.blur   * scale).toFixed(1);
    const spread = (sc.spread * scale).toFixed(1);
    const x      = (sc.xOffset * scale).toFixed(1);
    const y      = (sc.yOffset * scale).toFixed(1);
    return `box-shadow: ${x}px ${y}px ${blur}px ${spread}px rgba(0,0,0,${alpha})`;
}

/** Create and insert a custom shadow St.Bin below the window actor. */
function createShadow(actor) {
    // Outer bin: provides extra padding so the shadow can extend outside
    const shadow = new St.Bin({
        name: 'RWC Shadow',
    });

    // Inner bin: the actual CSS shadow is applied here
    const inner = new St.Bin({ x_expand: true, y_expand: true });
    inner.add_style_class_name('rwc-shadow');
    shadow.set_child(inner);

    // Bind x, y, width, height to the window actor (with padding offsets)
    const [dx, dy, dw, dh] = contentOffset(actor.metaWindow);
    const sc = scaleFactor(actor.metaWindow);
    const pad = SHADOW_PADDING * sc;

    const offsets = [
        dx - pad,      // X
        dy - pad,      // Y
        dw + 2 * pad,  // WIDTH
        dh + 2 * pad,  // HEIGHT
    ];

    for (let i = 0; i < 4; i++) {
        shadow.add_constraint(new Clutter.BindConstraint({
            source:     actor,
            coordinate: i,
            offset:     offsets[i],
        }));
    }

    // Clip-shadow effect prevents shadow from showing inside the window
    shadow.add_effect_with_name(CLIP_SHADOW_EFFECT, new ClipShadowEffect());

    global.windowGroup.insert_child_below(shadow, actor);

    refreshShadowStyle(actor, shadow);
    return shadow;
}

/** Update the CSS style of an existing shadow actor. */
function refreshShadowStyle(actor, shadowActor) {
    if (!shadowActor) return;

    const win        = actor.metaWindow;
    const sc         = scaleFactor(win);
    const origScale  = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const cssScale   = sc / origScale;

    const pad    = SHADOW_PADDING * cssScale;
    const cfg    = buildConfig();
    const scfg   = shadowConfig(win.appears_focused);

    // Compute the CSS border-radius to match the shader's squircle.
    // The shader uses:  exponent = smoothing*10+2,  radius = outerR * 0.5 * exponent
    // CSS border-radius only supports circular arcs (exponent=2).
    // A squircle extends further along diagonals than a circle of the same radius,
    // so using the shader's radius for the CSS guarantees the transparent background
    // never shows through the shader's transparent corners.
    const exponent    = cfg.smoothing * 10 + 2;
    const shaderR     = cfg.cornerRadius * 0.5 * exponent;
    const radius      = shaderR * cssScale;

    const inner = shadowActor.get_first_child();
    if (!inner) return;

    // Hide shadow when maximised/fullscreened (unless keep-shadow-maximized)
    const isMax  = win.maximizedHorizontally || win.maximizedVertically;
    const isFull = win.fullscreen;
    const hide   = (isMax || isFull) && !getB('keep-shadow-maximized');

    shadowActor.style = `padding: ${pad}px;`;

    // Use transparent background — NEVER white.  The box-shadow alone provides
    // the visual shadow.  A white background would bleed through the shader's
    // transparent squircle corners because CSS border-radius is circular.
    inner.style = hide
        ? 'opacity: 0;'
        : `background: transparent;
           border-radius: ${radius}px;
           ${boxShadowCss(scfg, cssScale)};
           margin: ${cfg.padding.top    * cssScale}px
                   ${cfg.padding.right  * cssScale}px
                   ${cfg.padding.bottom * cssScale}px
                   ${cfg.padding.left   * cssScale}px;`;
}

/** Update the ClipShadowEffect bounds for a shadow actor.
 *
 * The clip now uses the same squircle parameters as the RoundedCornersEffect
 * so the shadow is transparent exactly where the rounded corners are, with
 * pixel-perfect anti-aliasing along the curved edge.
 */
function refreshShadowClip(actor, shadowActor) {
    if (!shadowActor) return;

    const effect = shadowActor.get_effect(CLIP_SHADOW_EFFECT);
    if (!effect) return;

    const sw = shadowActor.width;
    const sh = shadowActor.height;
    if (sw <= 0 || sh <= 0) return;

    // Window content rect within the shadow actor in pixel coordinates.
    // Must mirror exactly the same coordinate system used by computeBounds().
    // The shadow actor is positioned via BindConstraint to the WindowActor,
    // so all bounds here are expressed in WindowActor coordinates + pad offset.
    const win = actor.metaWindow;
    const sc  = scaleFactor(win);
    const pad = SHADOW_PADDING * sc;

    const cfg    = buildConfig();
    const outerR = cfg.cornerRadius * sc;

    // Use the same exponent / radius formulae as RoundedCornersEffect
    // so the clip contour is identical to the rounded corners shader.
    let exponent = cfg.smoothing * 10 + 2;
    let radius   = outerR * 0.5 * exponent;

    let rawX1, rawY1, rawX2, rawY2;

    const isX11NoFrame =
        win.get_client_type() === Meta.WindowClientType.X11 &&
        !win.decorated;

    if (isX11NoFrame) {
        // Undecorated X11 (Electron): shader target is first_child.
        // The shadow actor is still bound to the WindowActor, so map
        // first_child bounds (0+inset … w-inset) into shadow-actor coords.
        const [dx, dy, dw, dh] = contentOffset(win);
        rawX1 = pad + dx + sc;
        rawY1 = pad + dy + sc;
        rawX2 = pad + dx + actor.width  + dw - sc;
        rawY2 = pad + dy + actor.height + dh - sc;
    } else {
        // Wayland or WM-decorated X11: shader target is the WindowActor.
        const [dx, dy, dw, dh] = contentOffset(win);
        rawX1 = pad + dx;
        rawY1 = pad + dy;
        rawX2 = pad + dx + actor.width  + dw;
        rawY2 = pad + dy + actor.height + dh;
    }

    // Account for padding inset (same as RoundedCornersEffect)
    const bx1 = rawX1 + cfg.padding.left   * sc;
    const by1 = rawY1 + cfg.padding.top    * sc;
    const bx2 = rawX2 - cfg.padding.right  * sc;
    const by2 = rawY2 - cfg.padding.bottom * sc;

    const maxR = Math.min(bx2 - bx1, by2 - by1) / 2;
    if (maxR > 0 && radius > maxR) {
        exponent *= maxR / radius;
        radius    = maxR;
    }

    effect.setClip([bx1, by1, bx2, by2], radius, exponent);
}

// ─────────────────────────────────────────────────────────────────────────────
// Effect application / removal
// ─────────────────────────────────────────────────────────────────────────────

/** Attach the RoundedCornersEffect and a custom shadow to a window actor. */
function onAddEffect(actor) {
    logDbg(`Adding effect to "${actor.metaWindow.title}"`);

    const win = actor.metaWindow;
    if (shouldSkip(win)) {
        logDbg(`  → skipped`);
        return;
    }

    const target = targetActor(actor);
    if (!target) return;

    target.add_effect_with_name(ROUNDED_CORNERS_EFFECT, new RoundedCornersEffect());

    let shadow = null;
    let bindings = [];

    if (getB('custom-shadow')) {
        shadow = createShadow(actor);

        // Mirror visibility / transform from window to shadow
        for (const prop of ['pivot-point', 'translation-x', 'translation-y',
                             'scale-x', 'scale-y', 'visible']) {
            bindings.push(actor.bind_property(prop, shadow, prop,
                GObject.BindingFlags.SYNC_CREATE));
        }
    }

    _actorMap.set(actor, { shadow, bindings, timeoutId: 0 });
    refreshRoundedCorners(actor);
}

/** Remove effects and shadow from a window actor. */
function onRemoveEffect(actor) {
    try {
        logDbg(`Removing effect from "${actor.metaWindow?.title}"`);
    } catch (_) {}

    try {
        const target = targetActor(actor);
        if (target)
            target.remove_effect_by_name(ROUNDED_CORNERS_EFFECT);
    } catch (_) {
        // Actor may already be destroyed
    }

    const data = _actorMap.get(actor);
    if (!data) return;

    // Unbind property mirrors
    for (const b of data.bindings)
        b.unbind();

    // Remove and destroy the custom shadow actor
    if (data.shadow) {
        try {
            data.shadow.get_constraints().forEach(c => data.shadow.remove_constraint(c));
            if (data.shadow.get_parent())
                global.windowGroup.remove_child(data.shadow);
            data.shadow.clear_effects();
            data.shadow.destroy();
        } catch (_) {
            // Shadow actor may already be destroyed
        }
    }

    if (data.timeoutId)
        GLib.source_remove(data.timeoutId);

    _actorMap.delete(actor);
}

/** Recompute and push all shader uniforms for a single window. */
function refreshRoundedCorners(actor) {
    const win = actor.metaWindow;
    if (!win) return;

    const data = _actorMap.get(actor);
    const fx   = getEffect(actor);

    // If neither the effect nor actor data exists, add the effect.
    // Guard against re-entry: only call onAddEffect when there is no _actorMap
    // entry yet (avoids the infinite loop onAddEffect → refreshRoundedCorners
    // → onAddEffect …). onAddEffect calls refreshRoundedCorners itself at the
    // end, so we just return here.
    if (!fx && !data) {
        onAddEffect(actor);
        return;
    }

    if (shouldSkip(win)) {
        if (data) onRemoveEffect(actor);
        return;
    }

    if (!fx) return;   // effect was removed due to shouldSkip during onAddEffect
    if (!fx.enabled) fx.enabled = true;

    const cfg = buildConfig();
    fx.updateUniforms(scaleFactor(win), cfg, computeBounds(actor));

    // Update shadow
    if (data) {
        refreshShadowStyle(actor, data.shadow);
        refreshShadowClip(actor, data.shadow);

        // Keep BindConstraint offsets in sync with the current window geometry
        const [dx, dy, dw, dh] = contentOffset(win);
        const sc  = scaleFactor(win);
        const pad = SHADOW_PADDING * sc;
        const newOffsets = [dx - pad, dy - pad, dw + 2 * pad, dh + 2 * pad];

        if (data.shadow) {
            data.shadow.get_constraints().forEach((c, i) => {
                if (c instanceof Clutter.BindConstraint)
                    c.offset = newOffsets[i];
            });
        }
    }
}

/** Refresh the shadow style / position for a single actor. */
function refreshFocus(actor) {
    const data = _actorMap.get(actor);
    if (data?.shadow)
        refreshShadowStyle(actor, data.shadow);
}

/** Remove and re-add the effect for a window actor. */
function refreshAll() {
    for (const actor of global.get_window_actors())
        refreshRoundedCorners(actor);
}

/** When windows are re-stacked, keep shadow actors sorted below their windows. */
function onRestacked() {
    for (const actor of global.get_window_actors()) {
        const data = _actorMap.get(actor);
        if (actor.visible && data?.shadow)
            global.windowGroup.set_child_below_sibling(data.shadow, actor);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Global signal management
// ─────────────────────────────────────────────────────────────────────────────

function addConnection(obj, signal, cb) {
    _connections.push({ object: obj, id: obj.connect(signal, cb) });
}

function removeConnections(obj) {
    let i = _connections.length;
    while (i--) {
        const c = _connections[i];
        if (!obj || c.object === obj) {
            c.object.disconnect(c.id);
            _connections.splice(i, 1);
        }
    }
}

function disconnectAll() {
    for (const c of _connections)
        c.object.disconnect(c.id);
    _connections = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-window signal setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

function attachWindowSignals(actor) {
    const win     = actor.metaWindow;
    const texture = actor.get_texture();

    // Window resized → update shader uniforms
    addConnection(actor,   'notify::size',  () => { if (actor.metaWindow) refreshRoundedCorners(actor); });
    if (texture)
        addConnection(texture, 'size-changed', () => { if (actor.metaWindow) refreshRoundedCorners(actor); });

    // Fullscreen state changed (may not cause a size change)
    addConnection(win, 'notify::fullscreen',     () => { if (actor.metaWindow) refreshRoundedCorners(actor); });
    // Focus changed → update shadow style
    addConnection(win, 'notify::appears-focused',() => { if (actor.metaWindow) refreshFocus(actor); });
    // Monitor / workspace change
    addConnection(win, 'workspace-changed',      () => { if (actor.metaWindow) refreshFocus(actor); });
}

function applyEffectTo(actor) {
    // Wayland / XWayland windows may not have a surface child yet.
    if (!actor.firstChild) {
        const connId = actor.connect('notify::first-child', () => {
            actor.disconnect(connId);
            applyEffectTo(actor);
        });
        return;
    }

    if (!actor.get_texture()) {
        // The compositor texture is not ready yet.  This happens with Qt /
        // OpenGL-accelerated X11 apps (VirtualBox, Qt-GL, some Chromium builds)
        // where the window is mapped before its first paint arrives.
        // Wait for the actor's size to change (first paint / resize), then retry.
        // We disconnect before retrying to avoid double-applying the effect.
        let connId;
        connId = actor.connect('notify::size', () => {
            actor.disconnect(connId);
            applyEffectTo(actor);
        });
        return;
    }

    // Add the effect FIRST, then connect signals. If signals were connected
    // before the effect, adding the effect could trigger notify::size
    // synchronously, causing re-entrant calls to refreshRoundedCorners
    // before _actorMap has been populated.
    onAddEffect(actor);
    attachWindowSignals(actor);
}

function removeEffectFrom(actor) {
    removeConnections(actor);
    removeConnections(actor.metaWindow);
    const tex = actor.get_texture();
    if (tex) removeConnections(tex);
    onRemoveEffect(actor);
}

// ─────────────────────────────────────────────────────────────────────────────
// Global enable / disable
// ─────────────────────────────────────────────────────────────────────────────

function enableEffect() {
    // Apply to all existing windows
    for (const actor of global.get_window_actors())
        applyEffectTo(actor);

    // New window created
    addConnection(global.display, 'window-created',
        (_, win) => {
            const actor = win.get_compositor_private();
            // get_wm_class_instance() may return null *or* an empty string
            // for apps (Qt, Electron) that set WM_CLASS asynchronously.
            // In both cases wait for the property to arrive before applying.
            if (!win.get_wm_class_instance()) {
                const nid = win.connect('notify::wm-class', () => {
                    win.disconnect(nid);
                    applyEffectTo(actor);
                });
            } else {
                applyEffectTo(actor);
            }
        });

    // Window closed
    addConnection(global.windowManager, 'destroy',
        (_, actor) => removeEffectFrom(actor));

    // Minimise: always hide shadow + disable effect to prevent the white
    // background of the shadow actor from showing during the animation.
    addConnection(global.windowManager, 'minimize',
        (_, actor) => {
            const data = _actorMap.get(actor);
            if (data?.shadow)
                data.shadow.visible = false;
            const fx = getEffect(actor);
            if (fx) fx.enabled = false;
        });

    // Unminimise: restore shadow + effect.  For the Magic-Lamp extension,
    // wait until the animation is nearly finished before showing the shadow.
    addConnection(global.windowManager, 'unminimize',
        (_, actor) => {
            const data = _actorMap.get(actor);
            const fx   = getEffect(actor);

            const lamp = actor.get_effect('unminimize-magic-lamp-effect');
            if (lamp && data?.shadow && fx) {
                data.shadow.visible = false;
                const timer = lamp.timerId;
                if (timer) {
                    const tid = timer.connect('new-frame', src => {
                        if (src.get_progress() > 0.98) {
                            data.shadow.visible = true;
                            fx.enabled = true;
                            src.disconnect(tid);
                        }
                    });
                }
                return;
            }

            // Standard unminimise (no magic lamp)
            if (data?.shadow)
                data.shadow.visible = true;
            if (fx) fx.enabled = true;
        });

    // Window re-stack → reorder shadow actors
    addConnection(global.display, 'restacked', onRestacked);

    // Settings changed → reapply all
    addConnection(_settings, 'changed', () => {
        _appTypeCache.clear();
        refreshAll();
    });
}

function disableEffect() {
    for (const actor of global.get_window_actors())
        removeEffectFrom(actor);
    disconnectAll();
    _appTypeCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension class
// ─────────────────────────────────────────────────────────────────────────────

export default class RoundedWindowCornersExtension extends Extension {

    #startupConnection = null;

    enable() {
        _settings = this.getSettings();
        logDbg('Enabling…');

        if (Main.layoutManager._startingUp) {
            // GNOME Shell is still starting up – wait until it is ready
            this.#startupConnection = Main.layoutManager.connect(
                'startup-complete', () => {
                    enableEffect();
                    Main.layoutManager.disconnect(this.#startupConnection);
                    this.#startupConnection = null;
                },
            );
        } else {
            enableEffect();
        }
    }

    disable() {
        logDbg('Disabling…');

        if (this.#startupConnection !== null) {
            Main.layoutManager.disconnect(this.#startupConnection);
            this.#startupConnection = null;
        }

        disableEffect();
        _settings = null;
        _mutterSettings = null;
        _fractionalScaling = null;
    }
}
