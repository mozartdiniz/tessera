// Tessera's Translator: a small window that translates with the lab's
// local model. The Translator applet starts it and toggles it; it stays
// running while hidden, so what's in it is still there the next time.
//
// The translation and proofreading rules live in lab-local (the gateway's
// local__translate and local__proofread tools), so every app of the lab uses
// the same tuned rules; this window only picks the tool and the languages.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';

import {programInvocationName} from 'system';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const APP_ID = 'org.tessera.Translator';

/** lab-gateway's REST endpoint; local__translate / local__proofread run on the GPU PC */
const GATEWAY_URL = 'http://linuxserver:7800/api/call';
const TOKEN_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'lab-notes', 'token']);
const SETTINGS_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'tessera', 'translator.json']);
/** A cold model load from the shared NTFS disk takes about 80 s */
const TIMEOUT = 300;
/** lab-local takes up to about 60k characters */
const MAX_INPUT_LENGTH = 60000;

/**
 * The same `language` on both sides proofreads instead of translating;
 * `spelling` is the variant to write.
 */
const LANGUAGES = [
    {code: 'pt-BR', name: 'Portuguese (Brazil)', language: 'pt'},
    {code: 'en-US', name: 'English (US)', language: 'en', spelling: 'American'},
    {code: 'en-GB', name: 'English (UK)', language: 'en', spelling: 'British'},
    {code: 'it', name: 'Italian', language: 'it'},
    {code: 'es', name: 'Spanish', language: 'es'},
];
/** Codes saved by earlier versions */
const RENAMED = {en: 'en-US'};

const DEFAULTS = {
    from: 'pt-BR',
    to: 'en-US',
    instructions: '',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * @param {string} code
 * @returns {number} its index in LANGUAGES, or 0
 */
function languageIndex(code) {
    code = RENAMED[code] ?? code;
    return Math.max(0, LANGUAGES.findIndex(l => l.code === code));
}

function loadSettings() {
    try {
        const [, bytes] = GLib.file_get_contents(SETTINGS_PATH);
        return {...DEFAULTS, ...JSON.parse(decoder.decode(bytes))};
    } catch {
        return {...DEFAULTS};
    }
}

function saveSettings(settings) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(SETTINGS_PATH), 0o755);
        GLib.file_set_contents(SETTINGS_PATH, encoder.encode(JSON.stringify(settings, null, 2)));
    } catch (e) {
        console.warn(`Failed to save the translator's settings: ${e.message}`);
    }
}

/**
 * Which lab tool does the job: the same language on both sides proofreads
 * (switching spelling when the variants differ, e.g. English UK to US),
 * anything else translates. The rules are lab-local's (Tessera's v2.1 rules,
 * moved there: the same task text for all 153 eval cases).
 *
 * @param {object} from - a LANGUAGES entry
 * @param {object} to - a LANGUAGES entry
 * @param {string} instructions - the user's own, may be empty
 * @param {string} text
 * @returns {{name: string, arguments: object}} the gateway call
 */
function toolCall(from, to, instructions, text) {
    if (from.language === to.language) {
        return {
            name: 'local__proofread',
            arguments: {text, language: from.code, convert_to: from.code === to.code ? '' : to.code, instructions},
        };
    }
    return {name: 'local__translate', arguments: {text, to: to.code, source: from.code, instructions}};
}

const TranslatorWindow = GObject.registerClass(
class TranslatorWindow extends Adw.ApplicationWindow {
    _init(application) {
        super._init({
            application,
            title: 'Translator',
            default_width: 520,
            default_height: 600,
        });

        this._settings = loadSettings();
        this._session = new Soup.Session({timeout: TIMEOUT});
        this._cancellable = null;
        /** What the clipboard held when it last filled the source */
        this._lastPrefill = null;

        const names = Gtk.StringList.new(LANGUAGES.map(l => l.name));
        this._from = new Gtk.DropDown({
            model: names,
            selected: languageIndex(this._settings.from),
            hexpand: true,
            tooltip_text: 'Translate from',
        });
        this._to = new Gtk.DropDown({
            model: names,
            selected: languageIndex(this._settings.to),
            hexpand: true,
            tooltip_text: 'Translate to',
        });
        this._from.connect('notify::selected', () => this._saveLanguages());
        this._to.connect('notify::selected', () => this._saveLanguages());

        const swap = new Gtk.Button({
            icon_name: 'object-flip-horizontal-symbolic',
            tooltip_text: 'Swap Languages',
            css_classes: ['flat'],
        });
        swap.connect('clicked', () => this._swap());

        const languages = new Gtk.Box({spacing: 6});
        languages.append(this._from);
        languages.append(swap);
        languages.append(this._to);

        this._instructions = new Gtk.Entry({
            text: this._settings.instructions,
            placeholder_text: 'Instructions, e.g. keep the tone, make it polite',
            secondary_icon_name: 'edit-clear-symbolic',
            secondary_icon_tooltip_text: 'Clear',
        });
        this._instructions.connect('icon-release', () => this._instructions.set_text(''));
        this._instructions.connect('changed', () => {
            this._settings.instructions = this._instructions.text.trim();
            saveSettings(this._settings);
        });
        this._instructions.connect('activate', () => this._translate());

        this._source = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 8,
            bottom_margin: 8,
            left_margin: 8,
            right_margin: 8,
        });
        this._source.buffer.connect('changed', () => this._syncButton());

        this._result = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 8,
            bottom_margin: 8,
            left_margin: 8,
            right_margin: 8,
        });

        this._button = new Gtk.Button({
            label: 'Translate',
            tooltip_text: 'Translate (Ctrl+Enter)',
            css_classes: ['suggested-action', 'pill'],
            halign: Gtk.Align.CENTER,
        });
        this._button.connect('clicked', () => {
            if (this._cancellable)
                this._cancellable.cancel();
            else
                this._translate();
        });
        this._spinner = new Adw.Spinner({visible: false});
        const actions = new Gtk.Box({spacing: 12, halign: Gtk.Align.CENTER});
        actions.append(this._button);
        actions.append(this._spinner);

        const copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy Translation',
            css_classes: ['flat'],
        });
        copy.connect('clicked', () => this._copy());
        const resultHeader = new Gtk.Box();
        resultHeader.append(new Gtk.Label({
            label: 'Translation',
            css_classes: ['heading'],
            xalign: 0,
            hexpand: true,
        }));
        resultHeader.append(copy);

        this._status = new Gtk.Label({
            css_classes: ['dim-label', 'caption'],
            xalign: 0,
            wrap: true,
        });

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 6,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        content.append(languages);
        content.append(this._instructions);
        content.append(framed(this._source));
        content.append(actions);
        content.append(resultHeader);
        content.append(framed(this._result));
        content.append(this._status);

        this._toasts = new Adw.ToastOverlay({child: content});
        const view = new Adw.ToolbarView({content: this._toasts});
        view.add_top_bar(new Adw.HeaderBar());
        this.set_content(view);

        // Captured, as the text views would take Ctrl+Enter for a newline
        const keys = new Gtk.ShortcutController({
            scope: Gtk.ShortcutScope.GLOBAL,
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        keys.add_shortcut(new Gtk.Shortcut({
            trigger: Gtk.ShortcutTrigger.parse_string('<Control>Return|<Control>KP_Enter'),
            action: Gtk.CallbackAction.new(() => {
                if (!this._cancellable)
                    this._translate();
                return true;
            }),
        }));
        keys.add_shortcut(new Gtk.Shortcut({
            trigger: Gtk.ShortcutTrigger.parse_string('Escape'),
            action: Gtk.CallbackAction.new(() => {
                this.close();
                return true;
            }),
        }));
        this.add_controller(keys);

        // Closing only hides it, keeping the texts
        this.connect('close-request', () => {
            this.set_visible(false);
            return true;
        });

        this._syncButton();
    }

    /**
     * Show the window; `text` (from the clipboard) becomes the source
     * when it's new since it last did.
     *
     * @param {string} text
     */
    showWith(text) {
        if (text?.trim() && text !== this._lastPrefill && !this._cancellable) {
            this._lastPrefill = text;
            this._source.buffer.set_text(text, -1);
            this._result.buffer.set_text('', -1);
            this._status.label = '';
        }
        this.present();
        this._source.grab_focus();
    }

    get _sourceText() {
        const {buffer} = this._source;
        return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
    }

    get _resultText() {
        const {buffer} = this._result;
        return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
    }

    _saveLanguages() {
        this._settings.from = LANGUAGES[this._from.selected].code;
        this._settings.to = LANGUAGES[this._to.selected].code;
        saveSettings(this._settings);
    }

    _swap() {
        const from = this._from.selected;
        this._from.selected = this._to.selected;
        this._to.selected = from;
        const result = this._resultText;
        if (result.trim() && !this._cancellable) {
            this._source.buffer.set_text(result, -1);
            this._result.buffer.set_text('', -1);
        }
    }

    _copy() {
        const text = this._resultText;
        if (!text)
            return;
        this.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes(
            'text/plain;charset=utf-8', new GLib.Bytes(encoder.encode(text))));
        this._toasts.add_toast(new Adw.Toast({title: 'Copied', timeout: 1}));
    }

    _syncButton() {
        const busy = !!this._cancellable;
        this._button.label = busy ? 'Cancel' : 'Translate';
        this._button.css_classes = busy
            ? ['destructive-action', 'pill'] : ['suggested-action', 'pill'];
        this._button.sensitive = busy || !!this._sourceText.trim();
        this._spinner.visible = busy;
    }

    async _translate() {
        const text = this._sourceText;
        if (!text.trim() || this._cancellable)
            return;
        if (text.length > MAX_INPUT_LENGTH) {
            this._status.label = `The text is too long: the local model takes up to ${MAX_INPUT_LENGTH} characters.`;
            return;
        }

        const from = LANGUAGES[this._from.selected];
        const to = LANGUAGES[this._to.selected];
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._status.label = 'Translating…';
        this._syncButton();

        try {
            const reply = await this._call(toolCall(from, to, this._settings.instructions, text), cancellable);
            this._result.buffer.set_text(reply.text, -1);
            this._status.label = `${reply.model} · ${reply.seconds} s`;
        } catch (e) {
            this._status.label = e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)
                ? 'Cancelled.' : e.message;
        } finally {
            this._cancellable = null;
            this._syncButton();
        }
    }

    /**
     * Run a lab-local tool through the gateway.
     *
     * @param {{name: string, arguments: object}} call - from toolCall()
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<{text: string, model: string, seconds: number}>}
     */
    async _call(call, cancellable) {
        let token;
        try {
            token = decoder.decode(GLib.file_get_contents(TOKEN_PATH)[1]).trim();
        } catch {
            throw new Error(`No lab token in ${TOKEN_PATH}.`);
        }

        const message = Soup.Message.new('POST', GATEWAY_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(encoder.encode(JSON.stringify(call))));

        let bytes;
        try {
            bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            throw new Error(`Can't reach the lab gateway: ${e.message}`);
        }
        const status = message.get_status();
        if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN)
            throw new Error('The lab gateway refused the token.');
        if (status !== Soup.Status.OK)
            throw new Error(`The lab gateway answered ${status} ${message.get_reason_phrase()}.`);

        let reply;
        try {
            const call = JSON.parse(decoder.decode(bytes.get_data()));
            reply = JSON.parse(call.structuredContent?.result ?? call.content?.[0]?.text);
            if (call.isError)
                throw new Error(call.content?.[0]?.text ?? 'error');
        } catch (e) {
            throw new Error(`Unexpected answer from the lab gateway: ${e.message}`);
        }

        switch (reply.verdict) {
        case 'check':
            return reply;
        case 'unavailable':
            throw new Error(`The local model is unavailable: ${(reply.error ?? '').replace(/; do the job yourself$/, '')}.`);
        default:
            throw new Error(reply.done_reason === 'length'
                ? 'The translation was cut off: try a shorter text.'
                : 'The local model gave no translation.');
        }
    }
});

/**
 * @param {Gtk.Widget} child
 * @returns {Gtk.Frame} `child` scrolled, in a frame that fills the height
 */
function framed(child) {
    return new Gtk.Frame({
        child: new Gtk.ScrolledWindow({
            child,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: 100,
        }),
        vexpand: true,
    });
}

const TranslatorApplication = GObject.registerClass(
class TranslatorApplication extends Adw.Application {
    _init() {
        super._init({application_id: APP_ID});

        // The applet calls it over D-Bus with the clipboard's text
        const show = new Gio.SimpleAction({
            name: 'show',
            parameter_type: new GLib.VariantType('s'),
        });
        show.connect('activate', (_a, param) => this._window.showWith(param.unpack()));
        this.add_action(show);

        const hide = new Gio.SimpleAction({name: 'hide'});
        hide.connect('activate', () => this._translatorWindow?.set_visible(false));
        this.add_action(hide);

        const quit = new Gio.SimpleAction({name: 'quit'});
        quit.connect('activate', () => this.quit());
        this.add_action(quit);
    }

    get _window() {
        this._translatorWindow ??= new TranslatorWindow(this);
        return this._translatorWindow;
    }

    vfunc_activate() {
        this._window.present();
    }
});

new TranslatorApplication().run([programInvocationName, ...ARGV]);
