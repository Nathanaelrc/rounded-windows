/**
 * effect.js – GLSL Clutter effects for Rounded Window Corners
 *
 * Two effects are provided:
 *   • RoundedCornersEffect – clips the window's corners using a fragment shader
 *     that supports both circular and squircle (superellipse) shapes.
 *   • ClipShadowEffect     – hides the shadow where it would bleed *behind*
 *     the rounded, transparent corners of a window.
 *
 * Based on the shader algorithm from:
 *   https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/compositor/meta-background-content.c
 * and the "Rounded Window Corners Reborn" extension by flexagoon:
 *   https://github.com/flexagoon/rounded-window-corners
 */

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

// ─────────────────────────────────────────────────────────────────────────────
// Fragment shader – rounded / squircle corners
// ─────────────────────────────────────────────────────────────────────────────
//
// Cogl snippet API splits the shader into two strings:
//   • DECLARATIONS – placed at the top of the generated GLSL file (uniforms
//     and helper functions)
//   • CODE          – injected into the fragment-hook body (modifies
//     cogl_color_out before it is written to the framebuffer)
//

const ROUNDED_CORNERS_DECLARATIONS = /* glsl */`
// Window bounds in logical pixel coordinates: (x1, y1, x2, y2)
uniform vec4  bounds;

// Visible corner / clip radius used by the rounding algorithm
uniform float clipRadius;

// Border: positive = inner border, negative = outer border, 0 = none
uniform float borderWidth;
uniform vec4  borderColor;       // RGBA

// Bounds / radius of the inner "bordered" area
// (differs from outer bounds when a border is active)
uniform vec4  borderedAreaBounds;
uniform float borderedAreaClipRadius;

// Squircle exponent:  2.0 = perfect circle,  >2.0 = squircle / superellipse
uniform float exponent;

// 1.0 / actor_width and 1.0 / actor_height – used to convert from
// normalised texture coordinates to logical pixel coordinates
uniform vec2  pixelStep;

// ── Circular corner bound ────────────────────────────────────────────────────
// Returns the opacity contribution of point p when using a circular corner
// of radius r centred on center.  The return value is smoothed so that the
// edge of the circle is 1 pixel wide (anti-aliasing).
float circleBounds(vec2 p, vec2 center, float r) {
    vec2  d     = p - center;
    float dist2 = dot(d, d);
    float outer = r + 0.5;
    if (dist2 >= outer * outer) return 0.0;
    float inner = r - 0.5;
    if (dist2 <= inner * inner) return 1.0;
    return outer - sqrt(dist2);     // ∈ (0, 1) – the anti-aliased edge
}

// ── Squircle corner bound ────────────────────────────────────────────────────
// Returns the opacity for a squircle corner (superellipse).
// Formula: dist = (|dx|^e + |dy|^e)^(1/e)  where e is the exponent.
float squircleBounds(vec2 p, vec2 center, float r, float e) {
    vec2  d    = abs(p - center);
    float dist = pow(pow(d.x, e) + pow(d.y, e), 1.0 / e);
    return clamp(r - dist + 0.5, 0.0, 1.0);
}

// ── Point opacity ────────────────────────────────────────────────────────────
// Returns the opacity (0–1) for point p with respect to a rectangle b and
// corner radius r.  Pixels clearly inside the window return 1.0 early so
// that the expensive sqrt / pow is only executed for corner pixels.
float getOpacity(vec2 p, vec4 b, float r, float e) {
    // Completely outside the window rect → fully transparent
    if (p.x < b.x || p.x > b.z || p.y < b.y || p.y > b.w) return 0.0;

    // Find the circle/squircle center for this corner.
    // If the point is far from any corner edge it is always opaque.
    float cl = b.x + r,  cr = b.z - r;
    float ct = b.y + r,  cb = b.w - r;

    vec2 c;
    if      (p.x < cl) c.x = cl;
    else if (p.x > cr) c.x = cr;
    else               return 1.0;   // ← horizontally in the safe zone

    if      (p.y < ct) c.y = ct;
    else if (p.y > cb) c.y = cb;
    else               return 1.0;   // ← vertically in the safe zone

    // Now we are in a corner — use the appropriate shape function.
    if (e <= 2.0)
        return circleBounds(p, c, r);
    else
        return squircleBounds(p, c, r, e);
}
`;

const ROUNDED_CORNERS_CODE = /* glsl */`
    // Convert normalised texture coordinate to logical pixel coordinate
    vec2  p = cogl_tex_coord0_in.xy / pixelStep;
    float a = getOpacity(p, bounds, clipRadius, exponent);

    if (borderWidth > 0.9 || borderWidth < -0.9) {
        // ── Border enabled ───────────────────────────────────────────────
        float ba = getOpacity(p, borderedAreaBounds, borderedAreaClipRadius, exponent);

        if (borderWidth > 0.0) {
            // Inner border: clip window first, then paint border on the edge
            cogl_color_out *= a;
            float edgeAlpha = clamp(abs(a - ba), 0.0, 1.0);
            cogl_color_out   = mix(cogl_color_out,
                                   vec4(borderColor.rgb, 1.0),
                                   edgeAlpha * borderColor.a);
        } else {
            // Outer border: draw border colour outside the window, window on top
            vec4 borderRect  = vec4(borderColor.rgb, 1.0) * ba * borderColor.a;
            cogl_color_out   = mix(borderRect, cogl_color_out, a);
        }
    } else {
        // ── No border ────────────────────────────────────────────────────
        cogl_color_out *= a;
    }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Fragment shader – clip shadow behind rounded-corner area
// ─────────────────────────────────────────────────────────────────────────────
const CLIP_SHADOW_DECLARATIONS = /* glsl */`
// Normalised (0–1) texture bounds within the shadow actor that correspond
// to the actual window content area.  Pixels inside this region are hidden
// so the shadow does not bleed through the transparent rounded corners.
uniform vec4 clipBounds;
`;

const CLIP_SHADOW_CODE = /* glsl */`
    vec2 tc = cogl_tex_coord0_in.xy;
    if (tc.x > clipBounds.x && tc.x < clipBounds.z &&
        tc.y > clipBounds.y && tc.y < clipBounds.w) {
        cogl_color_out = vec4(0.0, 0.0, 0.0, 0.0);
    }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Uniform location cache
//
// Shell.GLSLEffect assigns each uniform name a stable integer index.
// We cache the indices in a module-level object so they are fetched only once
// (the first RoundedCornersEffect instance initialises them; every subsequent
// instance reuses the same values, which is safe because all instances use the
// identical shader source).
// ─────────────────────────────────────────────────────────────────────────────
const RC_UNIFORMS = {
    bounds:                 -1,
    clipRadius:             -1,
    borderWidth:            -1,
    borderColor:            -1,
    borderedAreaBounds:     -1,
    borderedAreaClipRadius: -1,
    exponent:               -1,
    pixelStep:              -1,
};
let _rcUniformsReady = false;

// ─────────────────────────────────────────────────────────────────────────────
// RoundedCornersEffect
// ─────────────────────────────────────────────────────────────────────────────
export const RoundedCornersEffect = GObject.registerClass(
    { GTypeName: 'RWCRoundedCornersEffect' },
    class RoundedCornersEffect extends Shell.GLSLEffect {

        constructor() {
            super();
            // Populate the uniform index cache on the very first instance.
            if (!_rcUniformsReady) {
                for (const key of Object.keys(RC_UNIFORMS))
                    RC_UNIFORMS[key] = this.get_uniform_location(key);
                _rcUniformsReady = true;
            }
        }

        vfunc_build_pipeline() {
            this.add_glsl_snippet(
                Cogl.SnippetHook.FRAGMENT,
                ROUNDED_CORNERS_DECLARATIONS,
                ROUNDED_CORNERS_CODE,
                false,
            );
        }

        /**
         * Push updated values to every shader uniform.
         *
         * @param {number} scaleFactor  – monitor scale factor (HiDPI)
         * @param {object} cfg          – rounded corner configuration object
         * @param {object} windowBounds – {x1, y1, x2, y2} in logical pixels
         */
        updateUniforms(scaleFactor, cfg, windowBounds) {
            const bw = cfg.borderWidth * scaleFactor;
            const bc = cfg.borderColor;                       // [r, g, b, a]
            const outerR = cfg.cornerRadius * scaleFactor;
            const { padding, smoothing } = cfg;

            // Compute the four shader bounds (window rect minus per-side padding)
            const b = [
                windowBounds.x1 + padding.left   * scaleFactor,
                windowBounds.y1 + padding.top    * scaleFactor,
                windowBounds.x2 - padding.right  * scaleFactor,
                windowBounds.y2 - padding.bottom * scaleFactor,
            ];

            // Inset bounds for the bordered area
            const borderedBounds = [
                b[0] + bw, b[1] + bw,
                b[2] - bw, b[3] - bw,
            ];

            // Radius used inside the bordered area
            let borderInnerR = outerR - Math.abs(bw);
            if (borderInnerR < 0.001) borderInnerR = 0.0;

            // Pixel-step converts normalised tex-coords → pixel coords
            const ps = [
                1 / this.actor.get_width(),
                1 / this.actor.get_height(),
            ];

            // Convert smoothing (0–1) to a squircle exponent (2–12).
            // exponent = 2 → circular;  exponent > 2 → squircle.
            let exponent = smoothing * 10 + 2;
            let radius   = outerR * 0.5 * exponent;
            const maxR   = Math.min(b[2] - b[0], b[3] - b[1]) / 2;
            if (radius > maxR) {
                exponent *= maxR / radius;
                radius    = maxR;
            }
            borderInnerR *= radius / outerR;

            // Write all uniforms
            const u = RC_UNIFORMS;
            this.set_uniform_float(u.bounds,                 4, b);
            this.set_uniform_float(u.clipRadius,             1, [radius]);
            this.set_uniform_float(u.borderWidth,            1, [bw]);
            this.set_uniform_float(u.borderColor,            4, bc);
            this.set_uniform_float(u.borderedAreaBounds,     4, borderedBounds);
            this.set_uniform_float(u.borderedAreaClipRadius, 1, [borderInnerR]);
            this.set_uniform_float(u.pixelStep,              2, ps);
            this.set_uniform_float(u.exponent,               1, [exponent]);
            this.queue_repaint();
        }
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// ClipShadowEffect
// ─────────────────────────────────────────────────────────────────────────────
export const ClipShadowEffect = GObject.registerClass(
    { GTypeName: 'RWCClipShadowEffect' },
    class ClipShadowEffect extends Shell.GLSLEffect {

        #clipBoundsUniform = -1;

        vfunc_build_pipeline() {
            this.add_glsl_snippet(
                Cogl.SnippetHook.FRAGMENT,
                CLIP_SHADOW_DECLARATIONS,
                CLIP_SHADOW_CODE,
                false,
            );
            this.#clipBoundsUniform = this.get_uniform_location('clipBounds');
            // Default: no clipping (full bounds = nothing inside is hidden)
            this.set_uniform_float(this.#clipBoundsUniform, 4, [0.0, 0.0, 0.0, 0.0]);
        }

        /**
         * Set the normalised (0–1) region of the shadow actor that corresponds
         * to the window content.  Pixels in that region are made transparent.
         */
        setClip(x1, y1, x2, y2) {
            this.set_uniform_float(this.#clipBoundsUniform, 4, [x1, y1, x2, y2]);
            this.queue_repaint();
        }
    },
);
