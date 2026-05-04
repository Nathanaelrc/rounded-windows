/**
 * extension.js – Rounded Window Corners
 *
 * Applies GLSL-based rounded corners (and an optional custom shadow) to every
 * window that is not already drawn with libadwaita / libhandy.
 *
 * Changes vs original
 * ───────────────────
 * FIX 1 – Async file I/O
 *   getAppType() used GLib.file_get_contents() (synchronous, blocks main thread).
 *   Replaced with Gio.File.load_contents_async() wrapped in a Promise.
 *   A new async #detectAndCacheAppType() pre-populates the cache before
 *   #onAddEffect() runs so #shouldSkip() can remain synchronous.
 *
 * FIX 2 – No module-level mutable state
 *   All `let _foo` / `const _foo` module globals moved to private class fields
 *   (#foo) on the Extension class.  Pure stateless helpers stay as module
 *   functions.  Private methods (#method) replace the old top-level functions
 *   that referenced module state.
 *
 * FIX 3 – WeakMap for app-type cache
 *   _appTypeCache was Map<pid:number, string> — a plain number key cannot be
 *   garbage-collected.  Now #appTypeCache is WeakMap<Meta.Window, string>:
 *   entries are automatically eligible for GC when the window is destroyed,
 *   with no size-guard or manual clear() needed.
 *
 * Signal / lifecycle flow (unchanged)
 * ──────────────────────────────────
 * enable()
 *   └─ wait for shell startup → #enableEffect()
 *        ├─ connect global signals
 *        └─ #applyEffectTo() every existing window actor  [async]
 *
 * #applyEffectTo(actor)          [async]
 *   ├─ await #detectAndCacheAppType()   ← async procfs read (FIX 1)
 *   ├─ connect per-window signals
 *   └─ #onAddEffect(actor)
 *        ├─ add RoundedCornersEffect
 *        ├─ create shadow St.Bin
 *        └─ #refreshRoundedCorners()
 *
 * disable()
 *   ├─ #disableEffect() → #onRemoveEffect() every actor
 *   └─ null-out all instance state
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { RoundedCornersEffect, ClipShadowEffect } from './effect.js';

// ─────────────────────────────────────────────────────────────────────────────
// Module-level constants (immutable – fine at module scope)
// ─────────────────────────────────────────────────────────────────────────────
const ROUNDED_CORNERS_EFFECT = 'rwc-rounded-corners';
const CLIP_SHADOW_EFFECT      = 'rwc-clip-shadow';
const SHADOW_PADDING          = 80;

const ROUNDABLE_WINDOW_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
    Meta.WindowType.SPLASHSCREEN,
    Meta.WindowType.TOOLBAR,
].filter(type => type !== undefined);

// ─────────────────────────────────────────────────────────────────────────────
// Pure stateless helpers (no mutable state → fine as module functions)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeAppId(value) {
    if (typeof value !== 'string')
        return '';
    return value.trim().replace(/\.desktop$/i, '');
}

function getWindowIdentifiers(win) {
    const identifiers = new Set();
    const add = value => {
        if (typeof value !== 'string')
            return;
        const trimmed = value.trim();
        if (!trimmed)
            return;
        identifiers.add(trimmed);
        const normalized = normalizeAppId(trimmed);
        if (normalized)
            identifiers.add(normalized);
    };

    try {
        add(win.get_wm_class_instance?.());
        add(win.get_wm_class?.());
    } catch (_) {}

    try {
        add(win.gtkApplicationId ?? win.get_gtk_application_id?.());
    } catch (_) {}

    try {
        add(win.get_sandboxed_app_id?.());
    } catch (_) {}

    try {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker?.get_window_app(win) ?? null;
        add(app?.get_id?.());
        add(app?.get_name?.());
    } catch (_) {}

    return [...identifiers];
}

function isListedWindow(identifiers, list) {
    const lookup = new Set(
        identifiers.map(id => normalizeAppId(id)).filter(Boolean),
    );
    for (const item of list) {
        const normalized = normalizeAppId(item);
        if (normalized && lookup.has(normalized))
            return true;
    }
    return false;
}

/**
 * FIX 1 – Async procfs read.
 *
 * Wraps Gio.File.load_contents_async() in a Promise so callers can await it
 * without blocking the GNOME Shell main thread.
 * Returns the file contents as a decoded string, or '' on any error.
 */
function readFileContentsAsync(path) {
    return new Promise((resolve) => {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (f, res) => {
            try {
                const [ok, bytes] = f.load_contents_finish(res);
                resolve(ok ? new TextDecoder().decode(bytes) : '');
            } catch (_) {
                resolve('');
            }
        });
    });
}

function findTextureActor(actor) {
    if (!actor)
        return null;
    if (actor.get_texture?.())
        return actor;
    let child = actor.get_first_child?.() ?? null;
    while (child) {
        const textured = findTextureActor(child);
        if (textured)
            return textured;
        child = child.get_next_sibling?.() ?? null;
    }
    return null;
}

function boxShadowCss(sc, scale) {
    const alpha  = (sc.opacity / 255).toFixed(3);
    const blur   = (sc.blur   * scale).toFixed(1);
    const spread = (sc.spread * scale).toFixed(1);
    const x      = (sc.xOffset * scale).toFixed(1);
    const y      = (sc.yOffset * scale).toFixed(1);
    return `box-shadow: ${x}px ${y}px ${blur}px ${spread}px rgba(0,0,0,${alpha})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension class
// ─────────────────────────────────────────────────────────────────────────────

export default class RoundedWindowCornersExtension extends Extension {

    // ── FIX 2: All mutable state as private class fields ─────────────────
    //
    //   Previously these were `let _foo` / `const _foo` at module scope.
    //   Module-level mutable state leaks between enable/disable cycles and
    //   makes the extension harder to reason about.  Private class fields are
    //   scoped to each Extension instance and are reset implicitly by the GC
    //   when the extension object itself is collected.

    #settings           = null;
    #connections        = [];          // { object, id }[]  – global signals
    #actorMap           = new WeakMap(); // Meta.WindowActor → ActorData
    #mutterSettings     = null;
    #mutterSettingsConn = 0;
    #fractionalScaling  = null;
    #settingsTimeoutId  = 0;
    #startupConnection  = null;

    /**
     * FIX 3 – WeakMap keyed by Meta.Window (a GObject / JS object).
     *
     * The old Map<pid:number, string> used a primitive number as key.
     * Primitives cannot be WeakMap keys and cannot be automatically GC'd.
     * The original code guarded against unbounded growth with a `> 200 →
     * clear()` heuristic, which is both imprecise and potentially racy.
     *
     * Using Meta.Window as the key means each entry lives exactly as long as
     * the corresponding window object — no manual eviction required.
     */
    #appTypeCache = new WeakMap();  // Meta.Window → 'LibAdwaita' | 'LibHandy' | 'Other'

    // ── Settings helpers ──────────────────────────────────────────────────

    #getS(key) { return this.#settings.get_value(key).recursiveUnpack(); }
    #getB(key) { return this.#settings.get_boolean(key); }
    #getI(key) { return this.#settings.get_int(key); }
    #getD(key) { return this.#settings.get_double(key); }

    #buildConfig() {
        return {
            cornerRadius: this.#getI('corner-radius'),
            smoothing:    this.#getD('smoothing'),
            padding: {
                top:    this.#getI('padding-top'),
                bottom: this.#getI('padding-bottom'),
                left:   this.#getI('padding-left'),
                right:  this.#getI('padding-right'),
            },
            borderWidth: this.#getI('border-width'),
            borderColor: [
                this.#getD('border-red'),
                this.#getD('border-green'),
                this.#getD('border-blue'),
                this.#getD('border-alpha'),
            ],
            keepRoundedMaximized:  this.#getB('keep-rounded-maximized'),
            keepRoundedFullscreen: this.#getB('keep-rounded-fullscreen'),
        };
    }

    #shadowConfig(focused) {
        const prefix = focused ? 'focused-shadow' : 'unfocused-shadow';
        return {
            opacity:  this.#getI(`${prefix}-opacity`),
            blur:     this.#getI(`${prefix}-blur`),
            spread:   this.#getI(`${prefix}-spread`),
            xOffset:  this.#getI(`${prefix}-x-offset`),
            yOffset:  this.#getI(`${prefix}-y-offset`),
        };
    }

    // ── Logging ───────────────────────────────────────────────────────────

    #logDbg(msg) {
        if (this.#settings && this.#getB('debug-mode'))
            console.log(`[RoundedWindows] ${msg}`);
    }

    // ── FIX 1: Async app-type detection ──────────────────────────────────

    /**
     * Reads /proc/{pid}/maps asynchronously (Gio async API, non-blocking)
     * and writes the result into #appTypeCache keyed by the Meta.Window.
     *
     * The method is idempotent: if the cache already has an entry for this
     * window (e.g. called twice for the same actor) it returns immediately.
     *
     * Callers must await this before invoking #shouldSkip() so the cache is
     * warm when #shouldSkip() reads it.
     */
    async #detectAndCacheAppType(win) {
        if (this.#appTypeCache.has(win))
            return;

        let type = 'Other';
        try {
            const pid  = win.get_pid();
            const maps = await readFileContentsAsync(`/proc/${pid}/maps`);
            if (maps.includes('libadwaita-1.so'))
                type = 'LibAdwaita';
            else if (maps.includes('libhandy-1.so'))
                type = 'LibHandy';
        } catch (_) {
            // /proc may not be readable for all pids — treat as 'Other'
        }

        // Guard: the window may have been destroyed, or disable() may have
        // run while the async read was in flight.  Only write to the cache
        // when the extension is still active.
        if (this.#settings)
            this.#appTypeCache.set(win, type);
    }

    /** Synchronous cache lookup — always valid after #detectAndCacheAppType. */
    #getAppType(win) {
        return this.#appTypeCache.get(win) ?? 'Other';
    }

    // ── Window filtering ──────────────────────────────────────────────────

    #shouldSkip(win) {
        const identifiers = getWindowIdentifiers(win);

        // Always skip the DING desktop-icons extension actor
        if (identifiers.some(id =>
            ['com.rastersoft.ding', 'ding'].includes(normalizeAppId(id))))
            return true;

        const windowType = win.windowType ?? win.get_window_type?.();
        if (!ROUNDABLE_WINDOW_TYPES.includes(windowType))
            return true;

        const blacklist     = this.#getS('blacklist');
        const whitelistMode = this.#getB('whitelist-mode');
        const isListed      = isListedWindow(identifiers, blacklist);

        if (whitelistMode && !isListed) return true;
        if (!whitelistMode && isListed) return true;

        // #getAppType() reads from #appTypeCache (already populated async)
        const appType = this.#getAppType(win);
        if (this.#getB('skip-libadwaita-app') && appType === 'LibAdwaita' && !isListed)
            return true;
        if (this.#getB('skip-libhandy-app')   && appType === 'LibHandy'   && !isListed)
            return true;

        const cfg    = this.#buildConfig();
        const isMax  = win.maximizedHorizontally || win.maximizedVertically;
        const isFull = win.fullscreen;

        if (isMax  && !cfg.keepRoundedMaximized)  return true;
        if (isFull && !cfg.keepRoundedFullscreen) return true;

        return false;
    }

    // ── Actor helpers ─────────────────────────────────────────────────────

    #targetActor(actor) {
        return findTextureActor(actor) ?? actor;
    }

    #getWindowTexture(actor) {
        const target = this.#targetActor(actor);
        return target?.get_texture?.() ?? actor?.get_texture?.() ?? null;
    }

    #getEffect(actor) {
        const target = this.#targetActor(actor);
        return target ? target.get_effect(ROUNDED_CORNERS_EFFECT) : null;
    }

    #isFractionalScalingEnabled() {
        if (this.#fractionalScaling !== null)
            return this.#fractionalScaling;

        try {
            if (!this.#mutterSettings) {
                this.#mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
                this.#mutterSettingsConn = this.#mutterSettings.connect(
                    'changed::experimental-features',
                    () => {
                        this.#fractionalScaling = null;
                        this.#refreshAll();
                    });
            }

            const features   = this.#mutterSettings.get_strv('experimental-features');
            const isWayland  = !Meta.is_wayland_compositor || Meta.is_wayland_compositor();
            this.#fractionalScaling = isWayland && features.includes('scale-monitor-framebuffer');
        } catch (_) {
            this.#fractionalScaling = false;
        }
        return this.#fractionalScaling;
    }

    #scaleFactor(win) {
        if (this.#isFractionalScalingEnabled())
            return 1;
        const idx = win.get_monitor();
        return global.display.get_monitor_scale(idx);
    }

    #contentOffset(win) {
        const buf   = win.get_buffer_rect();
        const frame = win.get_frame_rect();
        return [
            frame.x - buf.x,
            frame.y - buf.y,
            frame.width  - buf.width,
            frame.height - buf.height,
        ];
    }

    #computeBounds(actor) {
        const win    = actor.metaWindow;
        const sc     = this.#scaleFactor(win);
        const target = this.#targetActor(actor) ?? actor;
        const targetW = target.width;
        const targetH = target.height;

        const [dx, dy, dw, dh] = this.#contentOffset(win);
        let x1 = dx,          y1 = dy;
        let x2 = dx + targetW + dw;
        let y2 = dy + targetH + dh;

        if (x1 === 0)       x1 += sc;
        if (y1 === 0)       y1 += sc;
        if (x2 === targetW) x2 -= sc;
        if (y2 === targetH) y2 -= sc;

        return { x1, y1, x2, y2 };
    }

    // ── Shadow helpers ────────────────────────────────────────────────────

    #createShadow(actor) {
        const shadow = new St.Bin({
            name:  'RWC Shadow',
            style: 'background: transparent;',
        });

        const inner = new St.Bin({ x_expand: true, y_expand: true });
        inner.add_style_class_name('rwc-shadow');
        shadow.set_child(inner);

        const win = actor.metaWindow;
        const sc  = this.#scaleFactor(win);
        const pad = SHADOW_PADDING * sc;

        const [dx, dy, dw, dh] = this.#contentOffset(win);
        const offsets = [dx - pad, dy - pad, dw + 2 * pad, dh + 2 * pad];

        for (let i = 0; i < 4; i++) {
            shadow.add_constraint(new Clutter.BindConstraint({
                source:     actor,
                coordinate: i,
                offset:     offsets[i],
            }));
        }

        shadow.add_effect_with_name(CLIP_SHADOW_EFFECT, new ClipShadowEffect());
        global.windowGroup.insert_child_below(shadow, actor);
        this.#refreshShadowStyle(actor, shadow);
        return shadow;
    }

    #refreshShadowStyle(actor, shadowActor) {
        if (!shadowActor) return;

        const win       = actor.metaWindow;
        const sc        = this.#scaleFactor(win);
        const origScale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const cssScale  = sc / origScale;
        const pad       = SHADOW_PADDING * cssScale;
        const cfg       = this.#buildConfig();
        const scfg      = this.#shadowConfig(win.appears_focused);

        const exponent = cfg.smoothing * 10 + 2;
        const shaderR  = cfg.cornerRadius * 0.5 * exponent;
        const radius   = shaderR * cssScale;

        const inner = shadowActor.get_first_child();
        if (!inner) return;

        const isMax  = win.maximizedHorizontally || win.maximizedVertically;
        const isFull = win.fullscreen;
        const hide   = (isMax || isFull) && !this.#getB('keep-shadow-maximized');

        shadowActor.style = `padding: ${pad}px;`;
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

    #refreshShadowClip(actor, shadowActor) {
        if (!shadowActor) return;

        const effect = shadowActor.get_effect(CLIP_SHADOW_EFFECT);
        if (!effect) return;

        const win = actor.metaWindow;
        const sc  = this.#scaleFactor(win);
        const pad = SHADOW_PADDING * sc;

        const [, , dw, dh] = this.#contentOffset(win);
        const sw = actor.width  + dw + 2 * pad;
        const sh = actor.height + dh + 2 * pad;
        if (sw <= 0 || sh <= 0) return;

        const cfg    = this.#buildConfig();
        const outerR = cfg.cornerRadius * sc;

        let exponent = cfg.smoothing * 10 + 2;
        let radius   = outerR * 0.5 * exponent;

        const rawX1 = pad;
        const rawY1 = pad;
        const rawX2 = pad + actor.width  + dw;
        const rawY2 = pad + actor.height + dh;

        const bx1 = rawX1 + cfg.padding.left   * sc;
        const by1 = rawY1 + cfg.padding.top    * sc;
        const bx2 = rawX2 - cfg.padding.right  * sc;
        const by2 = rawY2 - cfg.padding.bottom * sc;

        const maxR = Math.min(bx2 - bx1, by2 - by1) / 2;
        if (maxR > 0 && radius > maxR) {
            exponent *= maxR / radius;
            radius    = maxR;
        }

        effect.setClip([bx1, by1, bx2, by2], radius, exponent, sw, sh);
    }

    // ── Effect application / removal ──────────────────────────────────────

    #onAddEffect(actor) {
        this.#logDbg(`Adding effect to "${actor.metaWindow.title}"`);

        const win = actor.metaWindow;
        if (this.#shouldSkip(win)) {
            this.#logDbg('  → skipped');
            return;
        }

        const target = this.#targetActor(actor);
        if (!target) return;

        if (this.#actorMap.has(actor) || target.get_effect(ROUNDED_CORNERS_EFFECT)) {
            this.#refreshRoundedCorners(actor);
            return;
        }

        target.add_effect_with_name(ROUNDED_CORNERS_EFFECT, new RoundedCornersEffect());

        let shadow   = null;
        let bindings = [];

        if (this.#getB('custom-shadow')) {
            shadow = this.#createShadow(actor);
            for (const prop of ['pivot-point', 'translation-x', 'translation-y',
                                 'scale-x', 'scale-y', 'visible']) {
                bindings.push(actor.bind_property(prop, shadow, prop,
                    GObject.BindingFlags.SYNC_CREATE));
            }
        }

        this.#actorMap.set(actor, {
            shadow,
            bindings,
            connections:    [],
            signalsAttached: false,
            timeoutId:       0,
        });
        this.#refreshRoundedCorners(actor);
    }

    #onRemoveEffect(actor) {
        try {
            this.#logDbg(`Removing effect from "${actor.metaWindow?.title}"`);
        } catch (_) {}

        try {
            const target = this.#targetActor(actor);
            if (target)
                target.remove_effect_by_name(ROUNDED_CORNERS_EFFECT);
        } catch (_) {}

        const data = this.#actorMap.get(actor);
        if (!data) return;

        if (data.connections) {
            for (const c of data.connections) {
                try { c.obj.disconnect(c.id); } catch (_) {}
            }
            data.connections = [];
        }

        for (const b of data.bindings)
            b.unbind();

        if (data.shadow) {
            try {
                data.shadow.get_constraints().forEach(c =>
                    data.shadow.remove_constraint(c));
                if (data.shadow.get_parent())
                    global.windowGroup.remove_child(data.shadow);
                data.shadow.clear_effects();
                data.shadow.destroy();
            } catch (_) {}
        }

        if (data.timeoutId)
            GLib.source_remove(data.timeoutId);

        this.#actorMap.delete(actor);
    }

    #refreshRoundedCorners(actor) {
        const win = actor.metaWindow;
        if (!win) return;

        const data = this.#actorMap.get(actor);
        const fx   = this.#getEffect(actor);

        // Guard against re-entry: only call #onAddEffect when there is no
        // #actorMap entry yet.  #onAddEffect calls #refreshRoundedCorners
        // itself at the end, so we just return here.
        if (!fx && !data) {
            this.#onAddEffect(actor);
            return;
        }

        if (this.#shouldSkip(win)) {
            if (data) this.#onRemoveEffect(actor);
            return;
        }

        if (!fx) return;
        if (!fx.enabled) fx.enabled = true;

        const cfg = this.#buildConfig();
        fx.updateUniforms(this.#scaleFactor(win), cfg, this.#computeBounds(actor));

        if (data) {
            this.#refreshShadowStyle(actor, data.shadow);
            this.#refreshShadowClip(actor, data.shadow);

            const sc  = this.#scaleFactor(win);
            const pad = SHADOW_PADDING * sc;
            const [dx, dy, dw, dh] = this.#contentOffset(win);
            const newOffsets = [dx - pad, dy - pad, dw + 2 * pad, dh + 2 * pad];

            if (data.shadow) {
                data.shadow.get_constraints().forEach((c, i) => {
                    if (c instanceof Clutter.BindConstraint)
                        c.offset = newOffsets[i];
                });
            }
        }
    }

    #refreshFocus(actor) {
        const data = this.#actorMap.get(actor);
        if (data?.shadow)
            this.#refreshShadowStyle(actor, data.shadow);
    }

    #refreshAll() {
        for (const actor of global.get_window_actors())
            this.#refreshRoundedCorners(actor);
    }

    #onRestacked() {
        for (const actor of global.get_window_actors()) {
            const data = this.#actorMap.get(actor);
            if (actor.visible && data?.shadow)
                global.windowGroup.set_child_below_sibling(data.shadow, actor);
        }
    }

    // ── Global signal management ──────────────────────────────────────────

    #addConnection(obj, signal, cb) {
        this.#connections.push({ object: obj, id: obj.connect(signal, cb) });
    }

    #disconnectAll() {
        for (const c of this.#connections)
            c.object.disconnect(c.id);
        this.#connections = [];
    }

    // ── Per-window signal setup ───────────────────────────────────────────

    #attachWindowSignals(actor) {
        const data = this.#actorMap.get(actor);
        if (!data || data.signalsAttached)
            return;

        const addWinConn = (obj, sig, cb) => {
            if (obj) data.connections.push({ obj, id: obj.connect(sig, cb) });
        };

        const win     = actor.metaWindow;
        const texture = this.#getWindowTexture(actor);

        addWinConn(actor, 'notify::size',
            () => { if (actor.metaWindow) this.#refreshRoundedCorners(actor); });
        if (texture)
            addWinConn(texture, 'size-changed',
                () => { if (actor.metaWindow) this.#refreshRoundedCorners(actor); });

        addWinConn(win, 'notify::fullscreen',
            () => { if (actor.metaWindow) this.#refreshRoundedCorners(actor); });
        addWinConn(win, 'notify::appears-focused',
            () => { if (actor.metaWindow) this.#refreshFocus(actor); });
        addWinConn(win, 'workspace-changed',
            () => { if (actor.metaWindow) this.#refreshFocus(actor); });

        data.signalsAttached = true;
    }

    /**
     * Apply the rounded-corners effect to a window actor.
     *
     * Made async so the app-type detection (procfs read) can complete before
     * #shouldSkip() is called — keeping the main thread unblocked.
     *
     * The method is fire-and-forget from signal callbacks; Promises returned
     * from signal callbacks in GJS are safely ignored.
     */
    async #applyEffectTo(actor) {
        if (!actor?.metaWindow)
            return;

        // FIX 1: await async procfs read before any sync shouldSkip() call.
        await this.#detectAndCacheAppType(actor.metaWindow);

        // Guard: extension may have been disabled while we were awaiting, or
        // the window/actor may have been destroyed.
        if (!this.#settings || !actor.metaWindow)
            return;

        if (this.#actorMap.has(actor) || this.#getEffect(actor)) {
            this.#refreshRoundedCorners(actor);
            this.#attachWindowSignals(actor);
            return;
        }

        // Wayland / XWayland windows may not have a surface child yet.
        if (!actor.get_first_child?.()) {
            const connId = actor.connect('notify::first-child', () => {
                actor.disconnect(connId);
                this.#applyEffectTo(actor);
            });
            return;
        }

        if (!this.#getWindowTexture(actor)) {
            // Qt / OpenGL-accelerated X11 apps: texture not ready yet.
            // Wait for first paint / resize then retry.
            let connId;
            connId = actor.connect('notify::size', () => {
                actor.disconnect(connId);
                this.#applyEffectTo(actor);
            });
            return;
        }

        // Add effect first, then signals — prevents re-entrant
        // refreshRoundedCorners before #actorMap is populated.
        this.#onAddEffect(actor);
        this.#attachWindowSignals(actor);
    }

    async #applyEffectToWindow(win) {
        if (!win) return;

        const actor = win.get_compositor_private?.();
        if (actor) {
            await this.#applyEffectTo(actor);
            return;
        }

        let connId;
        connId = win.connect('notify::compositor-private', () => {
            const nextActor = win.get_compositor_private?.();
            if (!nextActor) return;
            win.disconnect(connId);
            this.#applyEffectTo(nextActor);
        });
    }

    // ── Global enable / disable ───────────────────────────────────────────

    #enableEffect() {
        // Apply to all existing windows (async – fire and forget concurrently)
        for (const actor of global.get_window_actors())
            this.#applyEffectTo(actor);

        this.#addConnection(global.display, 'window-created',
            (_, win) => this.#applyEffectToWindow(win));

        this.#addConnection(global.windowManager, 'destroy',
            (_, actor) => this.#onRemoveEffect(actor));

        // Minimise: hide shadow + disable effect to prevent shadow showing
        // through the minimise animation.
        this.#addConnection(global.windowManager, 'minimize',
            (_, actor) => {
                const data = this.#actorMap.get(actor);
                if (data?.shadow) data.shadow.visible = false;
                const fx = this.#getEffect(actor);
                if (fx) fx.enabled = false;
            });

        // Unminimise: restore shadow + effect.
        // Magic Lamp: wait until the animation is nearly done.
        this.#addConnection(global.windowManager, 'unminimize',
            (_, actor) => {
                const data = this.#actorMap.get(actor);
                const fx   = this.#getEffect(actor);

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

                if (data?.shadow) data.shadow.visible = true;
                if (fx)           fx.enabled = true;
            });

        // Re-stack: keep shadow actors sorted below their windows
        this.#addConnection(global.display, 'restacked',
            () => this.#onRestacked());

        // Settings changed: debounce 100 ms to prevent slider lag
        this.#addConnection(this.#settings, 'changed', () => {
            if (this.#settingsTimeoutId) {
                GLib.source_remove(this.#settingsTimeoutId);
                this.#settingsTimeoutId = 0;
            }
            this.#settingsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this.#refreshAll();
                this.#settingsTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    #disableEffect() {
        for (const actor of global.get_window_actors())
            this.#onRemoveEffect(actor);
        this.#disconnectAll();

        if (this.#settingsTimeoutId) {
            GLib.source_remove(this.#settingsTimeoutId);
            this.#settingsTimeoutId = 0;
        }

        if (this.#mutterSettings && this.#mutterSettingsConn) {
            this.#mutterSettings.disconnect(this.#mutterSettingsConn);
            this.#mutterSettingsConn = 0;
        }
    }

    // ── Public Extension API ──────────────────────────────────────────────

    enable() {
        this.#settings = this.getSettings();
        this.#logDbg('Enabling…');

        if (Main.layoutManager._startingUp) {
            this.#startupConnection = Main.layoutManager.connect(
                'startup-complete', () => {
                    this.#enableEffect();
                    Main.layoutManager.disconnect(this.#startupConnection);
                    this.#startupConnection = null;
                },
            );
        } else {
            this.#enableEffect();
        }
    }

    disable() {
        this.#logDbg('Disabling…');

        if (this.#startupConnection !== null) {
            Main.layoutManager.disconnect(this.#startupConnection);
            this.#startupConnection = null;
        }

        this.#disableEffect();

        // Null-out all instance state so nothing can be accidentally accessed
        // after disable().  #appTypeCache (WeakMap) is reset implicitly when
        // the window objects it references are collected.
        this.#settings          = null;
        this.#mutterSettings    = null;
        this.#fractionalScaling = null;
    }
}