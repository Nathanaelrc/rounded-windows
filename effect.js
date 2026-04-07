/**
 * effect.js – GLSL Clutter effects for Rounded Window Corners
 *
 * IMPORTANT design rules for Shell.GLSLEffect on GNOME 50 (Mutter 18):
 *
 *   In shell_glsl_effect_constructed(), Mutter does:
 *     1. klass->base_pipeline = cogl_pipeline_new(ctx)
 *     2. klass->build_pipeline(self)   ← vfunc_build_pipeline runs HERE
 *     3. priv->pipeline = cogl_pipeline_copy(klass->base_pipeline)
 *
 *   Therefore:
 *     - add_glsl_snippet() is ONLY valid inside vfunc_build_pipeline()
 *       (it operates on klass->base_pipeline which exists at that point).
 *     - get_uniform_location() must NOT be called in vfunc_build_pipeline()
 *       because it uses priv->pipeline which is still NULL at that point.
 *     - get_uniform_location() and set_uniform_float() are safe AFTER the
 *       constructor completes (priv->pipeline is set in step 3).
 *     - build_pipeline runs once per GType class, not per instance.
 *
 * Based on:
 *   https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/50.0/src/shell-glsl-effect.c
 *   https://github.com/flexagoon/rounded-window-corners
 */

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

// ─────────────────────────────────────────────────────────────────────────────
// GLSL – Rounded corners shader
// ─────────────────────────────────────────────────────────────────────────────

const ROUNDED_DECLARATIONS = /* glsl */`
uniform vec4  bounds;
uniform float clipRadius;
uniform float borderWidth;
uniform vec4  borderColor;
uniform vec4  borderedAreaBounds;
uniform float borderedAreaClipRadius;
uniform float exponent;
uniform vec2  pixelStep;

float circleBounds(vec2 p, vec2 center, float r) {
    vec2  d     = p - center;
    float dist2 = dot(d, d);
    float outer = r + 0.5;
    if (dist2 >= outer * outer) return 0.0;
    float inner = r - 0.5;
    if (dist2 <= inner * inner) return 1.0;
    return outer - sqrt(dist2);
}

float squircleBounds(vec2 p, vec2 center, float r, float e) {
    vec2  d    = abs(p - center);
    float dist = pow(pow(d.x, e) + pow(d.y, e), 1.0 / e);
    return clamp(r - dist + 0.5, 0.0, 1.0);
}

float getOpacity(vec2 p, vec4 b, float r, float e) {
    if (p.x < b.x || p.x > b.z || p.y < b.y || p.y > b.w) return 0.0;
    float cl = b.x + r, cr = b.z - r;
    float ct = b.y + r, cb = b.w - r;
    vec2 c;
    if      (p.x < cl) c.x = cl;
    else if (p.x > cr) c.x = cr;
    else               return 1.0;
    if      (p.y < ct) c.y = ct;
    else if (p.y > cb) c.y = cb;
    else               return 1.0;
    if (e <= 2.0)
        return circleBounds(p, c, r);
    else
        return squircleBounds(p, c, r, e);
}
`;

const ROUNDED_CODE = /* glsl */`
    vec2  p = cogl_tex_coord0_in.xy / pixelStep;
    float a = getOpacity(p, bounds, clipRadius, exponent);

    if (borderWidth > 0.9 || borderWidth < -0.9) {
        float ba = getOpacity(p, borderedAreaBounds, borderedAreaClipRadius, exponent);
        if (borderWidth > 0.0) {
            cogl_color_out *= a;
            float edgeAlpha = clamp(abs(a - ba), 0.0, 1.0);
            cogl_color_out = mix(cogl_color_out,
                                 vec4(borderColor.rgb, 1.0),
                                 edgeAlpha * borderColor.a);
        } else {
            vec4 borderRect = vec4(borderColor.rgb, 1.0) * ba * borderColor.a;
            cogl_color_out  = mix(borderRect, cogl_color_out, a);
        }
    } else {
        cogl_color_out *= a;
    }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL – Clip shadow shader
//
// Uses the same squircle formula as RoundedCornersEffect so the shadow is
// clipped with pixel-perfect precision along the rounded corners.
//
// Uniforms (all in shadow-actor pixel coordinates):
//   shadowBounds  – [x1, y1, x2, y2] of the WINDOW content area
//   shadowRadius  – squircle corner radius (matches RoundedCornersEffect)
//   shadowExp     – squircle exponent (matches RoundedCornersEffect)
//   shadowStep    – [1/actorW, 1/actorH] for the shadow actor
// ─────────────────────────────────────────────────────────────────────────────

const SHADOW_DECLARATIONS = /* glsl */`
uniform vec4  shadowBounds;
uniform float shadowRadius;
uniform float shadowExp;
uniform vec2  shadowStep;

float shadowCircleBounds(vec2 p, vec2 center, float r) {
    vec2  d     = p - center;
    float dist2 = dot(d, d);
    float outer = r + 0.5;
    if (dist2 >= outer * outer) return 0.0;
    float inner = r - 0.5;
    if (dist2 <= inner * inner) return 1.0;
    return outer - sqrt(dist2);
}

float shadowSquircleBounds(vec2 p, vec2 center, float r, float e) {
    vec2  d    = abs(p - center);
    float dist = pow(pow(d.x, e) + pow(d.y, e), 1.0 / e);
    return clamp(r - dist + 0.5, 0.0, 1.0);
}

float shadowGetOpacity(vec2 p, vec4 b, float r, float e) {
    if (p.x < b.x || p.x > b.z || p.y < b.y || p.y > b.w) return 0.0;
    float cl = b.x + r, cr = b.z - r;
    float ct = b.y + r, cb = b.w - r;
    vec2 c;
    if      (p.x < cl) c.x = cl;
    else if (p.x > cr) c.x = cr;
    else               return 1.0;
    if      (p.y < ct) c.y = ct;
    else if (p.y > cb) c.y = cb;
    else               return 1.0;
    if (e <= 2.0)
        return shadowCircleBounds(p, c, r);
    else
        return shadowSquircleBounds(p, c, r, e);
}
`;

const SHADOW_CODE = /* glsl */`
    vec2 p = cogl_tex_coord0_in.xy / shadowStep;
    // opacity = 1 inside the squircle, 0 outside, anti-aliased at edges
    float opacity = shadowGetOpacity(p, shadowBounds, shadowRadius, shadowExp);
    // Erase the shadow where the window content would be (inside the squircle)
    cogl_color_out *= (1.0 - opacity);
`;

// ─────────────────────────────────────────────────────────────────────────────
// RoundedCornersEffect
//
// add_glsl_snippet() goes in vfunc_build_pipeline() (operates on base_pipeline).
// get_uniform_location() is deferred to first updateUniforms() call, because
// priv->pipeline does not exist yet during build_pipeline in GNOME 50.
//
// HiDPI / fractional scaling:
// ClutterOffscreenEffect creates the FBO at logical resolution by default.
// We override vfunc_create_texture() to create it at physical resolution
// (logical × resource_scale) so the output is never upscaled → no blur.
// ─────────────────────────────────────────────────────────────────────────────
export const RoundedCornersEffect = GObject.registerClass(
    { GTypeName: 'RWCRoundedCornersEffect' },
    class RoundedCornersEffect extends Shell.GLSLEffect {

        _u = null;

        vfunc_build_pipeline() {
            this.add_glsl_snippet(
                Cogl.SnippetHook.FRAGMENT,
                ROUNDED_DECLARATIONS,
                ROUNDED_CODE,
                false,
            );
            // Do NOT call get_uniform_location() here.
            // priv->pipeline is NULL during build_pipeline in GNOME 50.
        }

        /**
         * Create the offscreen FBO texture at physical (HiDPI-aware) resolution.
         * Without this override, ClutterOffscreenEffect uses logical pixels and
         * the compositor upscales the result → blurry windows at >100% scale.
         */
        vfunc_create_texture(width, height) {
            const rs = this.actor ? (this.actor.get_resource_scale() ?? 1) : 1;
            const physW = Math.ceil(width  * rs);
            const physH = Math.ceil(height * rs);
            const ctx   = this.actor
                ? this.actor.get_context().get_backend().get_cogl_context()
                : null;
            if (!ctx) return super.vfunc_create_texture(width, height);
            try {
                return Cogl.Texture2D.new_with_size(ctx, physW, physH);
            } catch (_) {
                return super.vfunc_create_texture(width, height);
            }
        }

        _ensureUniforms() {
            if (this._u) return;
            this._u = {
                bounds:                 this.get_uniform_location('bounds'),
                clipRadius:             this.get_uniform_location('clipRadius'),
                borderWidth:            this.get_uniform_location('borderWidth'),
                borderColor:            this.get_uniform_location('borderColor'),
                borderedAreaBounds:     this.get_uniform_location('borderedAreaBounds'),
                borderedAreaClipRadius: this.get_uniform_location('borderedAreaClipRadius'),
                exponent:               this.get_uniform_location('exponent'),
                pixelStep:              this.get_uniform_location('pixelStep'),
            };
        }

        /**
         * Push updated values to every shader uniform.
         * @param {number} scaleFactor  – monitor scale factor (HiDPI)
         * @param {object} cfg          – rounded corner config from settings
         * @param {object} windowBounds – {x1, y1, x2, y2} in logical pixels
         */
        updateUniforms(scaleFactor, cfg, windowBounds) {
            this._ensureUniforms();
            if (!this._u) return;

            const bw     = cfg.borderWidth * scaleFactor;
            const bc     = cfg.borderColor;
            const outerR = cfg.cornerRadius * scaleFactor;
            const { padding, smoothing } = cfg;

            const b = [
                windowBounds.x1 + padding.left   * scaleFactor,
                windowBounds.y1 + padding.top    * scaleFactor,
                windowBounds.x2 - padding.right  * scaleFactor,
                windowBounds.y2 - padding.bottom * scaleFactor,
            ];

            const bb = [b[0] + bw, b[1] + bw, b[2] - bw, b[3] - bw];

            let borderInnerR = outerR - Math.abs(bw);
            if (borderInnerR < 0.001) borderInnerR = 0.0;

            // Use the physical FBO dimensions for pixelStep so the shader
            // coordinates match the actual texture resolution (HiDPI-correct).
            const rs     = this.actor ? (this.actor.get_resource_scale() ?? 1) : 1;
            const actorW = this.actor.get_width()  * rs;
            const actorH = this.actor.get_height() * rs;
            const ps = [
                actorW > 0 ? 1 / actorW : 1,
                actorH > 0 ? 1 / actorH : 1,
            ];

            // Scale bounds and radii to physical pixels for the shader
            const physScale = scaleFactor * rs;
            const bPhys = [
                windowBounds.x1 * rs + padding.left   * physScale,
                windowBounds.y1 * rs + padding.top    * physScale,
                windowBounds.x2 * rs - padding.right  * physScale,
                windowBounds.y2 * rs - padding.bottom * physScale,
            ];
            const bwPhys = cfg.borderWidth * physScale;
            const bbPhys = [bPhys[0] + bwPhys, bPhys[1] + bwPhys, bPhys[2] - bwPhys, bPhys[3] - bwPhys];
            const outerRPhys = cfg.cornerRadius * physScale;

            let exponent = smoothing * 10 + 2;
            let radius   = outerRPhys * 0.5 * exponent;
            const maxR   = Math.min(bPhys[2] - bPhys[0], bPhys[3] - bPhys[1]) / 2;
            if (maxR > 0 && radius > maxR) {
                exponent *= maxR / radius;
                radius    = maxR;
            }
            let borderInnerRPhys = outerRPhys - Math.abs(bwPhys);
            if (borderInnerRPhys < 0.001) borderInnerRPhys = 0.0;
            if (outerRPhys > 0)
                borderInnerRPhys *= radius / outerRPhys;

            const u = this._u;
            this.set_uniform_float(u.bounds,                 4, bPhys);
            this.set_uniform_float(u.clipRadius,             1, [radius]);
            this.set_uniform_float(u.borderWidth,            1, [bwPhys]);
            this.set_uniform_float(u.borderColor,            4, bc);
            this.set_uniform_float(u.borderedAreaBounds,     4, bbPhys);
            this.set_uniform_float(u.borderedAreaClipRadius, 1, [borderInnerRPhys]);
            this.set_uniform_float(u.pixelStep,              2, ps);
            this.set_uniform_float(u.exponent,               1, [exponent]);
            this.queue_repaint();
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// ClipShadowEffect
//
// Clips the custom CSS shadow so it is transparent exactly where the window
// content is — following the squircle shape instead of a plain rectangle.
// ─────────────────────────────────────────────────────────────────────────────
export const ClipShadowEffect = GObject.registerClass(
    { GTypeName: 'RWCClipShadowEffect' },
    class ClipShadowEffect extends Shell.GLSLEffect {

        _u = null;

        vfunc_build_pipeline() {
            this.add_glsl_snippet(
                Cogl.SnippetHook.FRAGMENT,
                SHADOW_DECLARATIONS,
                SHADOW_CODE,
                false,
            );
            // Do NOT call get_uniform_location() or set_uniform_float() here.
        }

        _ensureUniforms() {
            if (this._u) return;
            this._u = {
                bounds:  this.get_uniform_location('shadowBounds'),
                radius:  this.get_uniform_location('shadowRadius'),
                exp:     this.get_uniform_location('shadowExp'),
                step:    this.get_uniform_location('shadowStep'),
            };
        }

        /**
         * Update the squircle clip for the shadow actor.
         * @param {number[]} bounds  – [x1, y1, x2, y2] of the window content area
         *                             in shadow-actor pixel coordinates
         * @param {number}   radius  – squircle corner radius (same as RoundedCornersEffect)
         * @param {number}   exp     – squircle exponent (same as RoundedCornersEffect)
         */
        setClip(bounds, radius, exp) {
            this._ensureUniforms();
            if (!this._u) return;

            const w = this.actor.get_width();
            const h = this.actor.get_height();
            const step = [
                w > 0 ? 1 / w : 1,
                h > 0 ? 1 / h : 1,
            ];

            this.set_uniform_float(this._u.bounds,  4, bounds);
            this.set_uniform_float(this._u.radius,  1, [radius]);
            this.set_uniform_float(this._u.exp,     1, [exp]);
            this.set_uniform_float(this._u.step,    2, step);
            this.queue_repaint();
        }
    },
);
