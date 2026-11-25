import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Config from '../../../misc/config.js';
import * as Main from '../../main.js';
import {Applet} from '../applet.js';

const APP_ID = 'org.tessera.Translator';
const APP_PATH = '/org/tessera/Translator';
const APP_SCRIPT = GLib.build_filenamev([Config.PKGDATADIR, 'translator', 'main.js']);

/** Set by password managers on what they copy */
const SECRET_TYPE = 'x-kde-passwordManagerHint';

/**
 * Toggles the Translator, a window that translates with the lab's
 * local model (js/translator/main.js). A click shows it with what was
 * last copied as the text to translate, or hides it if it has the
 * focus. It shows on the current workspace, where it was last, and
 * above other windows unless Keep on Top is off. Hidden, it keeps
 * running with its texts.
 */
export const TranslatorDocklet = GObject.registerClass(
class TranslatorDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'translator-docklet'});

        this.set_child(this.makeIcon({
            style_class: 'applet-icon',
            icon_name: 'tessera-translator',
            icon_size: 36,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._running = false;
        /** Clipboard text for the app once it's on the bus */
        this._pendingText = null;
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, APP_ID,
            Gio.BusNameWatcherFlags.NONE,
            () => this._onAppeared(),
            () => (this._running = false));

        global.display.connectObject('window-created',
            (_d, window) => this._onWindowCreated(window), this);
        this.connect('destroy', () => Gio.bus_unwatch_name(this._watchId));
    }

    get defaults() {
        return {
            onTop: true,
            /** @type {{x: number, y: number, width: number, height: number}|null} */
            geometry: null,
        };
    }

    get claimedAppIds() {
        return [`${APP_ID}.desktop`];
    }

    buildMenu(menu) {
        this.addToggle(menu, _('Keep on Top'), 'onTop');
        if (this._running)
            menu.addAction(_('Quit Translator'), () => this._action('quit'));
    }

    settingsChanged(key) {
        const window = this._window;
        if (key !== 'onTop' || !window)
            return;
        if (this.settings.onTop)
            window.make_above();
        else
            window.unmake_above();
    }

    async activate() {
        const window = this._window;
        if (window?.has_focus()) {
            this._action('hide');
            return;
        }

        const text = await clipboardText();
        if (!this._running) {
            this._launch(text);
            return;
        }
        this._action('show', text);
        // Shown but behind another window: bring it here
        if (window)
            this._bringHere(window);
    }

    _launch(text) {
        this._pendingText = text;
        try {
            Gio.Subprocess.new(['gjs', '-m', APP_SCRIPT], Gio.SubprocessFlags.NONE);
        } catch (e) {
            this._pendingText = null;
            Main.notifyError(_('Failed to start the Translator'), e.message);
        }
    }

    _onAppeared() {
        this._running = true;
        if (this._pendingText === null)
            return;
        this._action('show', this._pendingText);
        this._pendingText = null;
    }

    /**
     * Activate one of the app's actions: show(text), hide or quit.
     *
     * @param {string} name
     * @param {string=} text
     */
    async _action(name, text) {
        const params = text === undefined ? [] : [new GLib.Variant('s', text)];
        try {
            await Gio.DBus.session.call(APP_ID, APP_PATH,
                'org.freedesktop.Application', 'ActivateAction',
                new GLib.Variant('(sava{sv})', [name, params, {}]),
                null, Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            console.warn(`Translator: failed to ${name} the window: ${e.message}`);
        }
    }

    /** @returns {Meta.Window|null} the Translator's window, if it's shown */
    get _window() {
        return global.get_window_actors().map(a => a.meta_window)
            .find(w => isTranslator(w)) ?? null;
    }

    _onWindowCreated(window) {
        // Its app id is known for sure once it shows
        const actor = window.get_compositor_private();
        const id = actor?.connect('first-frame', () => {
            actor.disconnect(id);
            if (!isTranslator(window))
                return;
            window.connect('unmanaging', () => this._saveGeometry(window));
            this._place(window);
            this._bringHere(window);
        });
    }

    _saveGeometry(window) {
        const {x, y, width, height} = window.get_frame_rect();
        this.setSetting('geometry', {x, y, width, height});
    }

    /**
     * Put `window` where it was last, inside the work area.
     *
     * @param {Meta.Window} window
     */
    _place(window) {
        const {geometry} = this.settings;
        if (!geometry)
            return;
        const ws = global.workspace_manager.get_active_workspace();
        const display = global.display;
        let monitor = display.get_monitor_index_for_rect(
            new Mtk.Rectangle({...geometry}));
        if (monitor < 0)
            monitor = display.get_primary_monitor();
        const area = ws.get_work_area_for_monitor(monitor);
        const width = Math.min(geometry.width, area.width);
        const height = Math.min(geometry.height, area.height);
        const x = Math.clamp(geometry.x, area.x, area.x + area.width - width);
        const y = Math.clamp(geometry.y, area.y, area.y + area.height - height);
        window.move_resize_frame(true, x, y, width, height);
    }

    _bringHere(window) {
        const ws = global.workspace_manager.get_active_workspace();
        if (!window.is_on_all_workspaces() && window.get_workspace() !== ws)
            window.change_workspace(ws);
        if (this.settings.onTop)
            window.make_above();
        Main.activateWindow(window);
    }
});

/** @param {Meta.Window} window */
function isTranslator(window) {
    if (window.get_wm_class() === APP_ID || window.get_gtk_application_id() === APP_ID)
        return true;
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return app?.get_id() === `${APP_ID}.desktop`;
}

/** @returns {Promise<string>} the clipboard's text, '' if none or a secret */
function clipboardText() {
    const clipboard = St.Clipboard.get_default();
    const types = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
    if (types.includes(SECRET_TYPE))
        return Promise.resolve('');
    return new Promise(resolve => {
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => resolve(text ?? ''));
    });
}
