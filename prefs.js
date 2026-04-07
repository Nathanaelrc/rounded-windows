/**
 * prefs.js – Preferences window for Rounded Window Corners
 *
 * UI is built with libadwaita (Adw) widgets on top of GTK4, following the
 * GNOME 45+ ExtensionPreferences API.
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ─────────────────────────────────────────────────────────────────────────────
// Small GTK4 helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Bind a Gtk.Adjustment to a GSettings integer key (bidirectional). */
function bindAdjInt(settings, key, adj) {
    adj.value = settings.get_int(key);
    adj.connect('value-changed', a => settings.set_int(key, a.value));
    settings.connect(`changed::${key}`, () => {
        if (adj.value !== settings.get_int(key))
            adj.value = settings.get_int(key);
    });
}

/** Bind a Gtk.Adjustment to a GSettings double key (bidirectional). */
function bindAdjDbl(settings, key, adj) {
    adj.value = settings.get_double(key);
    adj.connect('value-changed', a => settings.set_double(key, a.value));
    settings.connect(`changed::${key}`, () => {
        if (Math.abs(adj.value - settings.get_double(key)) > 1e-9)
            adj.value = settings.get_double(key);
    });
}

/** Bind a Gtk.Switch / Adw.SwitchRow active state to a GSettings bool key. */
function bindBool(settings, key, widget) {
    settings.bind(key, widget, 'active', 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Spin-row builder (Adw.ActionRow + Gtk.SpinButton as suffix widget)
// ─────────────────────────────────────────────────────────────────────────────
function makeSpinRow(title, subtitle, min, max, step, digits = 0) {
    const adj  = new Gtk.Adjustment({ lower: min, upper: max, step_increment: step });
    const spin = new Gtk.SpinButton({
        adjustment:   adj,
        digits:       digits,
        valign:       Gtk.Align.CENTER,
        width_chars:  5,
    });
    const row = new Adw.ActionRow({ title, subtitle });
    row.add_suffix(spin);
    row.activatable_widget = spin;
    return { row, adj, spin };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadow group builder
// ─────────────────────────────────────────────────────────────────────────────
function makeShadowGroup(title, prefix, settings) {
    const grp = new Adw.PreferencesGroup({ title });

    const opacity = makeSpinRow(_('Opacity'),  '',  0, 255, 1);
    const blur    = makeSpinRow(_('Blur'),      '',  0, 120, 1);
    const spread  = makeSpinRow(_('Spread'),    '', -50,  50, 1);
    const xOff    = makeSpinRow(_('X offset'),  '', -100, 100, 1);
    const yOff    = makeSpinRow(_('Y offset'),  '', -100, 100, 1);

    bindAdjInt(settings, `${prefix}-opacity`,  opacity.adj);
    bindAdjInt(settings, `${prefix}-blur`,     blur.adj);
    bindAdjInt(settings, `${prefix}-spread`,   spread.adj);
    bindAdjInt(settings, `${prefix}-x-offset`, xOff.adj);
    bindAdjInt(settings, `${prefix}-y-offset`, yOff.adj);

    grp.add(opacity.row);
    grp.add(blur.row);
    grp.add(spread.row);
    grp.add(xOff.row);
    grp.add(yOff.row);

    return grp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main preferences class
// ─────────────────────────────────────────────────────────────────────────────
export default class RoundedWindowsPreferences extends ExtensionPreferences {

    fillPreferencesWindow(win) {
        const settings = this.getSettings();
        win.set_default_size(680, 720);

        // ── Page 1: Corners ─────────────────────────────────────────────────
        const cornersPage = new Adw.PreferencesPage({
            title: _('Corners'),
            icon_name: 'emblem-photos-symbolic',
        });
        win.add(cornersPage);

        // ── Group: Corner shape ──────────────────────────────────────────────
        const shapeGroup = new Adw.PreferencesGroup({
            title:       _('Corner shape'),
            description: _('Controls the radius and curvature of the rounded corners.'),
        });
        cornersPage.add(shapeGroup);

        // Radius
        const radiusRow = makeSpinRow(
            _('Radius'), _('Corner radius in logical pixels'), 1, 50, 1);
        bindAdjInt(settings, 'corner-radius', radiusRow.adj);
        shapeGroup.add(radiusRow.row);

        // Smoothing (squircle)
        const smoothRow = makeSpinRow(
            _('Smoothing'),
            _('0 = perfect circle · 1 = squircle (super-ellipse)'),
            0, 1, 0.05, 2);
        bindAdjDbl(settings, 'smoothing', smoothRow.adj);
        shapeGroup.add(smoothRow.row);

        // ── Group: Padding ───────────────────────────────────────────────────
        const padGroup = new Adw.PreferencesGroup({
            title:       _('Clip padding'),
            description: _('Extra space (px) between the window edge and the clip boundary.'),
        });
        cornersPage.add(padGroup);

        for (const [side, key] of [
            [_('Top'),    'padding-top'],
            [_('Bottom'), 'padding-bottom'],
            [_('Left'),   'padding-left'],
            [_('Right'),  'padding-right'],
        ]) {
            const r = makeSpinRow(side, '', 0, 100, 1);
            bindAdjInt(settings, key, r.adj);
            padGroup.add(r.row);
        }

        // ── Group: Border ────────────────────────────────────────────────────
        const borderGroup = new Adw.PreferencesGroup({
            title:       _('Border'),
            description: _('Positive width = inner border · Negative = outer border · 0 = none'),
        });
        cornersPage.add(borderGroup);

        const bwRow = makeSpinRow(_('Width'), '', -15, 15, 1);
        bindAdjInt(settings, 'border-width', bwRow.adj);
        borderGroup.add(bwRow.row);

        // Border colour (RGBA via Gtk.ColorButton)
        const colorRow = new Adw.ActionRow({ title: _('Colour') });
        const colorBtn  = new Gtk.ColorButton({
            use_alpha: true,
            valign:    Gtk.Align.CENTER,
        });
        // Read initial colour from settings
        const updateColorBtn = () => {
            const rgba    = new Gdk.RGBA();
            rgba.red   = settings.get_double('border-red');
            rgba.green = settings.get_double('border-green');
            rgba.blue  = settings.get_double('border-blue');
            rgba.alpha = settings.get_double('border-alpha');
            colorBtn.set_rgba(rgba);
        };
        updateColorBtn();
        colorBtn.connect('color-set', () => {
            const c = colorBtn.get_rgba();
            settings.set_double('border-red',   c.red);
            settings.set_double('border-green', c.green);
            settings.set_double('border-blue',  c.blue);
            settings.set_double('border-alpha', c.alpha);
        });
        for (const k of ['border-red', 'border-green', 'border-blue', 'border-alpha'])
            settings.connect(`changed::${k}`, updateColorBtn);
        colorRow.add_suffix(colorBtn);
        borderGroup.add(colorRow);

        // ── Group: Behaviour ─────────────────────────────────────────────────
        const behGroup = new Adw.PreferencesGroup({ title: _('Behaviour') });
        cornersPage.add(behGroup);

        const maxRow  = new Adw.SwitchRow({
            title:    _('Keep rounded when maximised'),
            subtitle: _('Show rounded corners even for maximised windows'),
        });
        bindBool(settings, 'keep-rounded-maximized', maxRow);
        behGroup.add(maxRow);

        const fullRow = new Adw.SwitchRow({
            title:    _('Keep rounded when full-screen'),
            subtitle: _('Show rounded corners even in full-screen mode'),
        });
        bindBool(settings, 'keep-rounded-fullscreen', fullRow);
        behGroup.add(fullRow);

        // ── Page 2: Shadow ───────────────────────────────────────────────────
        const shadowPage = new Adw.PreferencesPage({
            title:     _('Shadow'),
            icon_name: 'weather-overcast-symbolic',
        });
        win.add(shadowPage);

        // Enable / disable custom shadow
        const shadowToggleGroup = new Adw.PreferencesGroup();
        shadowPage.add(shadowToggleGroup);

        const shadowRow = new Adw.SwitchRow({
            title:    _('Custom shadow'),
            subtitle: _('Replace the rectangular GNOME shadow with a rounded one'),
        });
        bindBool(settings, 'custom-shadow', shadowRow);
        shadowToggleGroup.add(shadowRow);

        const keepShadowRow = new Adw.SwitchRow({
            title:    _('Shadow when maximised'),
            subtitle: _('Keep the custom shadow when the window is maximised or full-screen'),
        });
        bindBool(settings, 'keep-shadow-maximized', keepShadowRow);
        shadowToggleGroup.add(keepShadowRow);

        // Focused / unfocused shadow settings
        shadowPage.add(makeShadowGroup(_('Focused window'),   'focused-shadow',   settings));
        shadowPage.add(makeShadowGroup(_('Unfocused window'), 'unfocused-shadow', settings));

        // ── Page 3: Applications ─────────────────────────────────────────────
        const appsPage = new Adw.PreferencesPage({
            title:     _('Applications'),
            icon_name: 'applications-all-symbolic',
        });
        win.add(appsPage);

        // Skip libadwaita / libhandy
        const skipGroup = new Adw.PreferencesGroup({
            title:       _('Skip native apps'),
            description: _('libadwaita / libhandy applications already draw their own rounded corners.'),
        });
        appsPage.add(skipGroup);

        const adwRow = new Adw.SwitchRow({ title: _('Skip libadwaita apps') });
        bindBool(settings, 'skip-libadwaita-app', adwRow);
        skipGroup.add(adwRow);

        const handyRow = new Adw.SwitchRow({ title: _('Skip libhandy apps') });
        bindBool(settings, 'skip-libhandy-app', handyRow);
        skipGroup.add(handyRow);

        // Blacklist / whitelist
        const listGroup = new Adw.PreferencesGroup({
            title:       _('Exceptions list'),
            description: _('WM class names, one per line. In normal mode these windows are EXCLUDED; ' +
                           'enable whitelist mode to ONLY apply rounded corners to them.'),
        });
        appsPage.add(listGroup);

        const whitelistRow = new Adw.SwitchRow({
            title:    _('Whitelist mode'),
            subtitle: _('Treat the list below as a whitelist instead of a blacklist'),
        });
        bindBool(settings, 'whitelist-mode', whitelistRow);
        listGroup.add(whitelistRow);

        // Multiline text editor for the blacklist
        const blacklistRow = new Adw.ActionRow({
            title: _('Exception list'),
        });
        const scrolled = new Gtk.ScrolledWindow({
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            min_content_height: 120,
            max_content_height: 240,
            hexpand: true,
        });
        const textView = new Gtk.TextView({
            monospace:     true,
            wrap_mode:     Gtk.WrapMode.NONE,
            top_margin:    6,
            bottom_margin: 6,
            left_margin:   8,
            right_margin:  8,
        });
        scrolled.set_child(textView);

        // Load initial value
        const loadList = () => {
            const list = settings.get_strv('blacklist');
            textView.buffer.text = list.join('\n');
        };
        loadList();

        // Save on buffer change (GTK4 removed focus-out-event)
        textView.buffer.connect('changed', () => {
            const text = textView.buffer.text;
            const list = text.split('\n').map(s => s.trim()).filter(s => s.length > 0);
            settings.set_strv('blacklist', list);
        });

        settings.connect('changed::blacklist', () => {
            const list = settings.get_strv('blacklist');
            const text = list.join('\n');
            if (textView.buffer.text !== text) textView.buffer.text = text;
        });

        const listBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        listBox.append(new Gtk.Label({
            label:  _('One WM class name per line. To find it, run:\n' +
                      '<tt>gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell ' +
                      '-m org.gnome.Shell.Eval "global.get_window_actors().map(a=>a.metaWindow.get_wm_class_instance())"</tt>'),
            use_markup: true,
            wrap:   true,
            xalign: 0,
            margin_top: 4,
        }));
        listBox.append(scrolled);

        const listExpander = new Adw.ExpanderRow({ title: _('Exception list') });
        // Use the Adw.ExpanderRow's add_row to add a wrapped child
        const wrap = new Adw.ActionRow();
        wrap.set_child(listBox);
        listExpander.add_row(wrap);
        listGroup.add(listExpander);

        // ── Page 4: About ────────────────────────────────────────────────────
        const aboutPage = new Adw.PreferencesPage({
            title:     _('About'),
            icon_name: 'help-about-symbolic',
        });
        win.add(aboutPage);

        const aboutGroup = new Adw.PreferencesGroup();
        aboutPage.add(aboutGroup);

        const nameRow = new Adw.ActionRow({ title: _('Rounded Window Corners') });
        nameRow.add_suffix(new Gtk.Label({
            label:  this.metadata['version-name'] ?? '1.0',
            xalign: 1,
            valign: Gtk.Align.CENTER,
        }));
        aboutGroup.add(nameRow);

        const srcRow = new Adw.ActionRow({
            title:    _('Source code'),
            subtitle: this.metadata.url ?? '',
            activatable: true,
        });
        srcRow.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
        srcRow.connect('activated', () => {
            const url = this.metadata.url;
            if (url) Gtk.show_uri(win, url, GLib.get_current_time());
        });
        aboutGroup.add(srcRow);

        // Debug toggle
        const debugGroup = new Adw.PreferencesGroup({ title: _('Developer') });
        aboutPage.add(debugGroup);
        const debugRow = new Adw.SwitchRow({
            title:    _('Debug logging'),
            subtitle: _('Print verbose logs to the GNOME Shell journal'),
        });
        bindBool(settings, 'debug-mode', debugRow);
        debugGroup.add(debugRow);
    }
}
