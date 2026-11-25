import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from '../../main.js';
import * as SystemActions from '../../../misc/systemActions.js';
import {Applet} from '../applet.js';

/**
 * Stands in for the top bar's system menu: a click opens the panel's
 * Quick Settings (toggles, sliders, lock, log out, power off) next to
 * the tile, on whichever side faces into the screen.
 */
export const SystemDocklet = GObject.registerClass(
class SystemDocklet extends Applet {
    _init(appletId, settings) {
        super._init(appletId, settings, {style_class: 'system-docklet'});

        this.set_child(this.makeIcon({
            style_class: 'applet-icon',
            icon_name: 'tessera-system',
            icon_size: 32,
        }));

        this._systemActions = SystemActions.getDefault();

        this._quickSettings = Main.panel.statusArea.quickSettings ?? null;
        this._quickMenu = this._quickSettings?.menu ?? null;
        if (this._quickMenu) {
            // Adopt the menu so Super+S opens it here too; the side
            // and alignment are worked out again on every open.
            this._anchorMenu();
            this._quickMenu.connectObject('open-state-changed', (_m, open) => {
                if (open)
                    this._anchorMenu();
                this.checked = open;
            }, this);
            // On shutdown the panel can go first
            this._quickSettings.connectObject('destroy', () => {
                this._quickSettings = null;
                this._quickMenu = null;
            }, this);
        }
        this.connect('destroy', () => this._onDestroy());
    }

    activate() {
        this._quickMenu?.toggle();
    }

    buildMenu(menu) {
        const actions = this._systemActions;
        if (actions.canLockScreen)
            menu.addAction(_('Lock Screen'), () => actions.activateLockScreen());
        if (actions.canSuspend)
            menu.addAction(_('Suspend'), () => actions.activateSuspend());
        if (actions.canLogout)
            menu.addAction(_('Log Out…'), () => actions.activateLogout());
        if (actions.canRestart)
            menu.addAction(_('Restart…'), () => actions.activateRestart());
        if (actions.canPowerOff)
            menu.addAction(_('Power Off…'), () => actions.activatePowerOff());
        this.addAppAction(menu, _('Settings'), 'org.gnome.Settings.desktop');
    }

    /**
     * Open on the side facing into the screen, sliding the menu along
     * the tile's edge so it grows away from the nearest corner.
     */
    _anchorMenu() {
        if (!this._quickMenu)
            return;

        const side = this.menuSide;
        const monitor = Main.layoutManager.findMonitorForActor(this) ??
            Main.layoutManager.primaryMonitor;
        const [x, y] = this.get_transformed_position();
        const [w, h] = this.get_transformed_size();
        let alignment;
        if (side === St.Side.LEFT || side === St.Side.RIGHT) {
            alignment = (y + h / 2 - monitor.y) / monitor.height;
        } else {
            alignment = (x + w / 2 - monitor.x) / monitor.width;
            // BoxPointer mirrors horizontal alignment for RTL
            if (this.text_direction === Clutter.TextDirection.RTL)
                alignment = 1 - alignment;
        }
        this._quickMenu.setSource(this, Math.clamp(alignment, 0, 1), side);
    }

    _onDestroy() {
        if (this._quickMenu) {
            // Give the menu back to the (hidden) panel button
            this._quickMenu.close({animate: false});
            this._quickMenu.setSource(this._quickSettings, 0, St.Side.TOP);
        }
    }
});
