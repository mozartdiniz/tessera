import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from '../../main.js';
import * as PopupMenu from '../../popupMenu.js';
import {Applet} from '../applet.js';

const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const HOVER_TIME = 400;
const PREVIEW_LENGTH = 300;
const THUMBNAIL_SIZE = 64;
/** Bigger copies aren't kept */
const MAX_TEXT_LENGTH = 1024 * 1024;
const MAX_IMAGE_SIZE = 16 * 1024 * 1024;

const TEXT_TYPES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/bmp', 'image/gif', 'image/webp'];
/** Set by password managers on what they copy */
const SECRET_TYPE = 'x-kde-passwordManagerHint';

/**
 * The clipboard's history, like WindowMaker's wmclipboard dockapp or
 * Windows' Win+V: the tile shows how many copies it keeps.
 * A click, or Super+V, lists them, newest first; choosing one copies
 * it again, the pin keeps it for good and × forgets it. Middle-click
 * clears the history.
 *
 * The history is only kept in memory, so it's gone after logging out,
 * and copies from password managers are left out. Pinned texts are
 * saved with the applet's settings.
 */
export const ClipboardDocklet = GObject.registerClass(
class ClipboardDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'clipboard-docklet'});

        const box = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this.makeIcon({
            style_class: 'applet-icon clipboard-docklet-icon',
            icon_name: 'tessera-clipboard',
            icon_size: 36,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._count = new St.Label({
            style_class: 'applet-small clipboard-docklet-count',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        box.add_child(this._count);
        this.set_child(box);

        /** @type {{text?: string, mimetype?: string, bytes?: GLib.Bytes}[]} newest first */
        this._history = [];
        this._showingPopup = false;

        global.display.get_selection().connectObject('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._read();
        }, this);
        this._read();

        Main.wm.addKeybinding('toggle-clipboard',
            new Gio.Settings({schema_id: SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP,
            () => this._togglePopup());

        this._hoverId = 0;
        this.connect('notify::hover', () => this._onHover());
        this.connect('destroy', () => {
            Main.wm.removeKeybinding('toggle-clipboard');
            if (this._hoverId)
                GLib.source_remove(this._hoverId);
        });
        this.tick();
    }

    get defaults() {
        return {
            size: 25,
            images: true,
            pinned: [],
        };
    }

    get _pinned() {
        return Array.isArray(this.settings.pinned)
            ? this.settings.pinned.filter(t => typeof t === 'string') : [];
    }

    // ---- the clipboard ----------------------------------------------

    _read() {
        const clipboard = St.Clipboard.get_default();
        const types = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (!types.length || types.includes(SECRET_TYPE))
            return;

        if (TEXT_TYPES.some(t => types.includes(t))) {
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
                if (text?.trim() && text.length <= MAX_TEXT_LENGTH)
                    this._add({text});
            });
            return;
        }
        const mimetype = IMAGE_TYPES.find(t => types.includes(t));
        if (!mimetype || !this.settings.images)
            return;
        clipboard.get_content(St.ClipboardType.CLIPBOARD, mimetype, (_c, bytes) => {
            const size = bytes?.get_size() ?? 0;
            // The clipboard frees `bytes` after this returns: keep a copy
            if (size > 0 && size <= MAX_IMAGE_SIZE)
                this._add({mimetype, bytes: new GLib.Bytes(bytes.toArray())});
        });
    }

    /** Put `entry` on top, or move it there if it's in already. */
    _add(entry) {
        this._history = [entry, ...this._history.filter(e => !sameEntry(e, entry))]
            .slice(0, this.settings.size);
        this._changed();
    }

    _copy(entry) {
        const clipboard = St.Clipboard.get_default();
        if (entry.text !== undefined)
            clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
        else
            clipboard.set_content(St.ClipboardType.CLIPBOARD, entry.mimetype, entry.bytes);
    }

    _forget(entry) {
        this._history = this._history.filter(e => e !== entry);
        this._changed();
    }

    _clear() {
        this._history = [];
        this._changed();
    }

    _setPinned(text, pinned) {
        const others = this._pinned.filter(t => t !== text);
        this.setSetting('pinned', pinned ? [text, ...others] : others);
        this._refreshPopup();
    }

    _changed() {
        this.tick();
        this._refreshPopup();
    }

    // ---- the tile ---------------------------------------------------

    tick() {
        const [latest] = this._history;
        this._count.text = this._history.length ? String(this._history.length) : '';
        this.accessible_name = latest
            ? _('Clipboard: %s').format(oneLine(latest))
            : _('Clipboard is empty');
        if (this.tooltipShown)
            this.showTooltip(this._tooltipText());
    }

    settingsChanged(key) {
        if (key === 'size') {
            this._history = this._history.slice(0, this.settings.size);
            this._changed();
        } else if (key === 'images' && !this.settings.images) {
            this._history = this._history.filter(e => e.text !== undefined);
            this._changed();
        } else {
            this.tick();
        }
    }

    activate(button) {
        if (button === Clutter.BUTTON_MIDDLE)
            this._clear();
        else if (button === Clutter.BUTTON_PRIMARY)
            this._openPopup();
    }

    openMenu() {
        this._showingPopup = false;
        super.openMenu();
    }

    buildMenu(menu) {
        if (this._history.length)
            menu.addAction(_('Clear History'), () => this._clear());
        this.addChoice(menu, _('Keep'), 'size', [
            [10, _('10 Copies')],
            [25, _('25 Copies')],
            [50, _('50 Copies')],
        ]);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.addToggle(menu, _('Keep Images'), 'images');
    }

    _tooltipText() {
        const [latest] = this._history;
        const hint = _('Click or Super+V: history · Middle-click: clear');
        return latest ? `${ellipsize(oneLine(latest), 60)}\n${hint}` : hint;
    }

    _onHover() {
        if (this._hoverId)
            GLib.source_remove(this._hoverId);
        this._hoverId = 0;
        if (!this.hover) {
            this.hideTooltip();
            return;
        }
        this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_TIME, () => {
            this._hoverId = 0;
            if (this.hover && !this._menu?.isOpen)
                this.showTooltip(this._tooltipText());
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- the list ---------------------------------------------------

    _togglePopup() {
        if (this._showingPopup && this._menu?.isOpen)
            this._menu.close();
        else
            this._openPopup();
    }

    _openPopup() {
        this._showingPopup = true;
        this.openPopup(menu => this._buildPopup(menu));
        this._focusFirstRow();
    }

    _refreshPopup() {
        if (!this._showingPopup || !this._menu?.isOpen)
            return;
        this._menu.removeAll();
        this._buildPopup(this._menu);
    }

    /** So the arrow keys and Enter pick a copy right away. */
    _focusFirstRow() {
        this._firstRow?.grab_key_focus();
    }

    _buildPopup(menu) {
        const pinned = this._pinned;
        const history = this._history.filter(e => e.text === undefined || !pinned.includes(e.text));
        this._firstRow = null;

        if (!pinned.length && !history.length) {
            const empty = new PopupMenu.PopupMenuItem(_('Nothing Copied Yet'), {reactive: false});
            empty.add_style_class_name('clipboard-applet-empty');
            menu.addMenuItem(empty);
        } else {
            const list = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'clipboard-applet-list',
            });
            if (pinned.length) {
                list.add_child(heading(_('Pinned')));
                for (const text of pinned)
                    list.add_child(this._createRow({text}, true));
                if (history.length)
                    list.add_child(heading(_('Recent')));
            }
            for (const entry of history)
                list.add_child(this._createRow(entry, false));
            const scroll = new St.ScrollView({
                style_class: 'clipboard-applet-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                child: list,
            });
            // Not reactive itself: the rows are buttons of their own
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            item.add_child(scroll);
            menu.addMenuItem(item);
        }

        if (this._history.length) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(_('Clear History'), () => this._clear());
        }
    }

    _createRow(entry, pinned) {
        const row = new St.BoxLayout({style_class: 'clipboard-applet-row'});

        let content;
        if (entry.text !== undefined) {
            content = new St.Label({
                style_class: 'clipboard-applet-text',
                text: ellipsize(entry.text.trim(), PREVIEW_LENGTH),
                x_expand: true,
            });
            content.clutter_text.line_wrap = true;
            content.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        } else {
            content = new St.Icon({
                style_class: 'clipboard-applet-image',
                gicon: new Gio.BytesIcon({bytes: entry.bytes}),
                icon_size: THUMBNAIL_SIZE,
                x_align: Clutter.ActorAlign.START,
            });
        }

        const copy = new St.Button({
            style_class: 'clipboard-applet-copy',
            child: content,
            can_focus: true,
            x_expand: true,
            accessible_name: oneLine(entry),
        });
        copy.connect('clicked', () => {
            this._menu?.close();
            this._copy(entry);
        });
        row.add_child(copy);
        this._firstRow ??= copy;

        if (entry.text !== undefined) {
            const pin = new St.Button({
                style_class: 'clipboard-applet-action',
                icon_name: 'view-pin-symbolic',
                accessible_name: pinned ? _('Unpin') : _('Pin'),
                can_focus: true,
                y_align: Clutter.ActorAlign.START,
            });
            if (pinned)
                pin.add_style_pseudo_class('checked');
            pin.connect('clicked', () => this._setPinned(entry.text, !pinned));
            row.add_child(pin);
        }
        if (!pinned) {
            const forget = new St.Button({
                style_class: 'clipboard-applet-action',
                icon_name: 'window-close-symbolic',
                accessible_name: _('Forget'),
                can_focus: true,
                y_align: Clutter.ActorAlign.START,
            });
            forget.connect('clicked', () => this._forget(entry));
            row.add_child(forget);
        }
        return row;
    }
});

function sameEntry(a, b) {
    if (a.text !== undefined || b.text !== undefined)
        return a.text === b.text;
    return a.mimetype === b.mimetype && a.bytes.equal(b.bytes);
}

/** @returns {string} the entry on one line, for the tile and labels */
function oneLine(entry) {
    if (entry.text === undefined)
        return _('Image');
    return ellipsize(entry.text.trim().replace(/\s+/g, ' '), PREVIEW_LENGTH);
}

function ellipsize(text, length) {
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function heading(text) {
    return new St.Label({style_class: 'clipboard-applet-heading', text});
}
