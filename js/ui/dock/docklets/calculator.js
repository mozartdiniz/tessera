import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from '../../popupMenu.js';
import * as ShellEntry from '../../shellEntry.js';
import {Applet} from '../applet.js';

const HOVER_TIME = 400;
const HISTORY_SIZE = 10;

const FUNCTIONS = {
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    abs: Math.abs,
    exp: Math.exp,
    ln: Math.log,
    log: Math.log10,
    log2: Math.log2,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
};

/** Other ways to write an operator */
const OPERATORS = {
    '**': '^',
    '×': '*',
    '·': '*',
    '÷': '/',
    '−': '-',
};

/**
 * @param {string} text
 * @returns {{type: string, value: (string|number)}[]}
 */
function tokenize(text) {
    const tokens = [];
    const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([a-z_][a-z0-9_]*|π)|(\*\*|[-+*/^%()×·÷−]))/iy;
    while (re.lastIndex < text.length) {
        const start = re.lastIndex;
        const m = re.exec(text);
        if (!m) {
            if (text.slice(start).trim() === '')
                break;
            const char = text.slice(start).trim()[0];
            throw new Error(_('Unexpected “%s”').format(char));
        }
        if (m[1] !== undefined)
            tokens.push({type: 'number', value: Number(m[1])});
        else if (m[2] !== undefined)
            tokens.push({type: 'name', value: m[2].toLowerCase()});
        else
            tokens.push({type: 'op', value: OPERATORS[m[3]] ?? m[3]});
    }
    return tokens;
}

/**
 * Work out arithmetic like "3 * (4+8) * 0.5": + - * / ^, parentheses,
 * % for percent, a number before a name or "(" multiplies, functions
 * like sqrt(2) and the constants pi, e and ans (the last result).
 * Angles are in radians.
 *
 * @param {string} text
 * @param {number|null} ans - the last result
 * @returns {number}
 * @throws {Error} saying what's wrong, for the user
 */
export function evaluate(text, ans) {
    const tokens = tokenize(text);
    let pos = 0;

    const peek = () => tokens[pos];
    const isOp = (token, ...ops) => token?.type === 'op' && ops.includes(token.value);
    const expect = op => {
        if (!isOp(peek(), op))
            throw new Error(peek() ? _('Expected “%s”').format(op) : _('Incomplete expression'));
        pos++;
    };

    // expression := term (('+' | '-') term)*
    const expression = () => {
        let value = term();
        while (isOp(peek(), '+', '-'))
            value = tokens[pos++].value === '+' ? value + term() : value - term();
        return value;
    };

    // term := unary (('*' | '/') unary | unary starting with a name or '(')*
    const term = () => {
        let value = unary();
        for (;;) {
            const next = peek();
            if (isOp(next, '*', '/')) {
                pos++;
                value = next.value === '*' ? value * unary() : value / unary();
            } else if (next?.type === 'name' || isOp(next, '(')) {
                value *= unary();
            } else {
                return value;
            }
        }
    };

    // unary := ('-' | '+') unary | power
    const unary = () => {
        if (isOp(peek(), '-', '+'))
            return tokens[pos++].value === '-' ? -unary() : unary();
        return power();
    };

    // power := percent ('^' unary)?, so 2^3^2 = 2^9 and -2^2 = -4
    const power = () => {
        const base = percent();
        if (!isOp(peek(), '^'))
            return base;
        pos++;
        return base ** unary();
    };

    // percent := primary '%'*
    const percent = () => {
        let value = primary();
        while (isOp(peek(), '%')) {
            pos++;
            value /= 100;
        }
        return value;
    };

    const primary = () => {
        const token = tokens[pos++];
        if (!token)
            throw new Error(_('Incomplete expression'));
        if (token.type === 'number')
            return token.value;
        if (isOp(token, '(')) {
            const value = expression();
            expect(')');
            return value;
        }
        if (token.type === 'name') {
            const name = token.value;
            if (name in FUNCTIONS) {
                expect('(');
                const value = expression();
                expect(')');
                return FUNCTIONS[name](value);
            }
            if (name === 'pi' || name === 'π')
                return Math.PI;
            if (name === 'e')
                return Math.E;
            if (name === 'ans') {
                if (ans === null)
                    throw new Error(_('No result yet for “ans”'));
                return ans;
            }
            throw new Error(_('Unknown name “%s”').format(name));
        }
        throw new Error(_('Unexpected “%s”').format(token.value));
    };

    if (!tokens.length)
        throw new Error(_('Nothing to calculate'));
    const value = expression();
    if (pos < tokens.length)
        throw new Error(_('Unexpected “%s”').format(tokens[pos].value));
    if (!Number.isFinite(value))
        throw new Error(Number.isNaN(value) ? _('Not a number') : _('Too big, or divided by zero'));
    return value;
}

/**
 * @param {number} value
 * @returns {string} `value` to 12 significant digits, so 0.1 + 0.2 is 0.3
 */
export function formatResult(value) {
    const rounded = Number(value.toPrecision(12));
    return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * A calculator you type into: a click opens a field for an expression
 * like "3 * (4+8) * 0.5", already focused so it can be typed or pasted
 * right away; the result shows while typing and Enter keeps it in the
 * history below. In the history, the copy button copies a result and
 * clicking a row puts its expression back in the field. The history
 * is saved with the applet's settings.
 */
export const CalculatorDocklet = GObject.registerClass(
class CalculatorDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'calculator-docklet'});

        this.set_child(this.makeIcon({
            style_class: 'applet-icon',
            icon_name: 'tessera-calculator',
            icon_size: 36,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        /** What's in the field, kept for the next time it opens */
        this._text = '';
        this._entry = null;
        this._resultLabel = null;
        this._historyBox = null;

        this._hoverId = 0;
        this.connect('notify::hover', () => this._onHover());
        this.connect('destroy', () => {
            if (this._hoverId)
                GLib.source_remove(this._hoverId);
        });
    }

    get defaults() {
        return {
            /** @type {{expression: string, result: string}[]} newest first */
            history: [],
        };
    }

    get _history() {
        return Array.isArray(this.settings.history)
            ? this.settings.history.filter(h =>
                typeof h?.expression === 'string' && typeof h?.result === 'string')
            : [];
    }

    activate(button) {
        if (button === Clutter.BUTTON_PRIMARY)
            this._openCalculator();
    }

    buildMenu(menu) {
        if (this._history.length)
            menu.addAction(_('Clear History'), () => this._clearHistory());
    }

    settingsChanged(key) {
        if (key === 'history')
            this._fillHistory();
    }

    _clearHistory() {
        this.setSetting('history', []);
    }

    // ---- the popup --------------------------------------------------

    _openCalculator() {
        this.openPopup(menu => this._buildPopup(menu));
        // Typing or pasting replaces what was there; Enter works it out again
        this._entry.grab_key_focus();
        this._entry.clutter_text.set_selection(0, -1);
    }

    _buildPopup(menu) {
        const box = new St.BoxLayout({
            style_class: 'calculator-applet',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._entry = new St.Entry({
            style_class: 'calculator-applet-entry',
            hint_text: _('e.g. 3 * (4+8) * 0.5'),
            text: this._text,
            can_focus: true,
            x_expand: true,
        });
        ShellEntry.addContextMenu(this._entry);
        // Gone when the popup is next built, or used for the settings menu
        this._entry.connect('destroy', () => {
            this._entry = null;
            this._resultLabel = null;
            this._historyBox = null;
        });
        this._entry.clutter_text.connect('text-changed', () => {
            this._text = this._entry.text;
            this._preview();
        });
        this._entry.clutter_text.connect('activate', () => this._calculate());
        box.add_child(this._entry);

        this._resultLabel = new St.Label({
            style_class: 'calculator-applet-result',
            x_align: Clutter.ActorAlign.END,
        });
        this._resultLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._resultLabel);

        this._historyBox = new St.BoxLayout({
            style_class: 'calculator-applet-history',
            orientation: Clutter.Orientation.VERTICAL,
        });
        box.add_child(this._historyBox);

        // Not reactive itself: the entry and rows take the input
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(box);
        menu.addMenuItem(item);

        this._preview();
        this._fillHistory();
    }

    get _ans() {
        const [last] = this._history;
        return last ? Number(last.result) : null;
    }

    /** Show the result while typing; mistakes only show on Enter. */
    _preview() {
        this._entry.remove_style_pseudo_class('error');
        this._resultLabel.remove_style_class_name('error');
        let text = '';
        try {
            if (this._entry.text.trim())
                text = `= ${formatResult(evaluate(this._entry.text, this._ans))}`;
        } catch {
        }
        this._resultLabel.text = text;
    }

    _calculate() {
        const expression = this._entry.text.trim();
        if (!expression)
            return;
        let result;
        try {
            result = formatResult(evaluate(expression, this._ans));
        } catch (e) {
            this._entry.add_style_pseudo_class('error');
            this._resultLabel.add_style_class_name('error');
            this._resultLabel.text = e.message;
            return;
        }
        this._resultLabel.text = `= ${result}`;
        this.setSetting('history', [
            {expression, result},
            ...this._history.filter(h => h.expression !== expression),
        ].slice(0, HISTORY_SIZE));
        this._entry.clutter_text.set_selection(0, -1);
    }

    _fillHistory() {
        if (!this._historyBox)
            return;
        this._historyBox.destroy_all_children();
        const history = this._history;
        this._historyBox.visible = history.length > 0;
        for (const entry of history)
            this._historyBox.add_child(this._createRow(entry));
    }

    _createRow({expression, result}) {
        const row = new St.BoxLayout({style_class: 'calculator-applet-row'});

        const content = new St.BoxLayout({x_expand: true});
        const expressionLabel = new St.Label({
            style_class: 'calculator-applet-expression',
            text: expression,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        expressionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        content.add_child(expressionLabel);
        const resultLabel = new St.Label({
            style_class: 'calculator-applet-row-result',
            text: result,
            y_align: Clutter.ActorAlign.CENTER,
        });
        resultLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        content.add_child(resultLabel);

        const restore = new St.Button({
            style_class: 'calculator-applet-restore',
            child: content,
            can_focus: true,
            x_expand: true,
            accessible_name: _('Edit “%s”').format(expression),
        });
        restore.connect('clicked', () => {
            this._entry.text = expression;
            this._entry.grab_key_focus();
            this._entry.clutter_text.set_cursor_position(-1);
            this._entry.clutter_text.set_selection_bound(-1);
        });
        row.add_child(restore);

        const copy = new St.Button({
            style_class: 'calculator-applet-copy',
            icon_name: 'edit-copy-symbolic',
            accessible_name: _('Copy %s').format(result),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        copy.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, result);
            this._menu?.close();
        });
        row.add_child(copy);
        return row;
    }

    // ---- the tile ---------------------------------------------------

    _tooltipText() {
        const [last] = this._history;
        const hint = _('Click to calculate');
        return last ? `${last.expression} = ${last.result}\n${hint}` : hint;
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
});
