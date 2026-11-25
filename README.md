# Tessera

A WindowMaker-style desktop for GNOME, built as a fork of GNOME Shell 51.
The top panel and the overview are gone. Instead, every app, applet and
control is a tile that docks to the nearest screen edge, wherever you drop
it. Each tile is one piece of the mosaic: a *tessera*.

It installs next to stock GNOME as its own login session, so you pick it on
the login screen and can always go back.

## What's in it

- **Tiles on every edge.** Drag any tile anywhere; it snaps to the nearest
  edge and keeps its spot. Edges with tiles reserve their space, so
  maximized windows stay clear of them. Pinned and running apps have tiles;
  click to raise or hide an app, and drop files on a tile to open them.
- **Applets**, added from the launcher's Applets tab or the desktop menu:
  System (quick settings, lock, log out), Clock, Date, Timer, Weather,
  Figaro (music), Claude Usage, Claude Agent, Notifications, Caffeine,
  Clipboard, Translator, Color Picker, CPU, Memory, Network, Volume,
  Battery, Workspaces, Folder, Eyes, Trash, and the Clip.
- **The Clip**, as in WindowMaker. It switches workspaces (arrows in its
  corners, or scroll) and holds icons per workspace. Its extra:
  - **Click** for Focus mode: every tile outside the Clip slides away and
    gives its space to the windows. It can turn on by itself when a window
    is maximized, and pushing the pointer against an edge peeks at it.
  - **Ctrl+click** for Exposé: the workspace's windows spread out to pick
    one.
  - **Middle-click** collapses its icons; **right-click** for its menu.
  - **Workspace sets**: its menu saves the workspace under a name, with
    its windows, wallpaper and Focus mode, and opens a set again on any
    workspace, starting the apps that aren't running. The root menu's
    Workspace → Sets can also open one in a new workspace.
- **A wallpaper per workspace**, as WindowMaker's WorkspaceSpecificBack:
  pick one from the Clip's menu or the root menu, or drop an image on
  the Clip. Each workspace's name shows in the middle of the screen when
  you switch to it.
- **Clipboard history**: the Clipboard applet keeps what you copied
  (text and images, not password managers' copies) until you log out.
  Click it or press Super+V to copy something again; pin what you want
  to keep.
- **Translator**: the Translator applet toggles a small window above the
  others that translates between Portuguese (Brazil), English (US),
  English (UK), Italian and Spanish with the lab's local model
  (`local__run` through lab-gateway, with the token in
  `~/.config/lab-notes/token`). The same language on both sides
  proofreads instead, keeping your wording. It opens with what you copied
  last, and you can add instructions for the model, such as “keep the
  tone”, “make it polite” or “fix only the spelling”. Ctrl+Enter
  translates.
- **Desktop icons** for the files in your Desktop folder, which WindowMaker
  left to other programs. It works like a file manager's desktop: a file
  saved there shows up at once; click, Ctrl/Shift+click or drag a
  rectangle to select, double-click or Enter to open. Drag icons to
  another spot, into a folder, onto a launcher, a Folder applet (into
  its folder), an app's tile or the Trash, or out to any app; drag files
  in from any app, or out of a Folder applet's fan (Ctrl copies, Shift
  moves). Right-click an icon for Open With, Cut, Copy, Rename,
  Move to Trash and Properties; Ctrl+C/X/V, Delete, F2, Ctrl+Shift+N
  and Ctrl+Z work as in Files, which does the copying with its progress,
  questions and undo. The root menu's Desktop submenu hides the icons,
  lines them up again, pastes and makes new folders. The icons are a
  small app of their own (`js/desktop/`) that the shell keeps under
  every window.
- **Launcher** with search on Super (all apps with Super+A), and a
  WindowMaker **root menu** on a right-click on the desktop. A middle-click
  on the desktop, or Super+F11, lists every window.
- **Fixed workspaces**, as in WindowMaker. Stock GNOME keeps its dynamic
  ones.

| Shortcut | |
|---|---|
| Super | Launcher |
| Super+A | All apps |
| Super+S | Quick settings |
| Super+Z | Focus mode |
| Super+E | Exposé |
| Super+V | Clipboard history (with the Clipboard applet) |
| Super+M | Notification list |
| Super+F11 | Window list |

## Install

Tessera needs **Fedora with GNOME 51** (Fedora 45).

```sh
git clone https://github.com/mozartdiniz/tessera.git
cd tessera
./install.sh
```

The script installs the build dependencies with dnf, builds Tessera into
`~/.local/tessera` and adds the **Tessera** session to the login screen; it
asks for your password once. Then log out, click your name, pick
**Tessera** with the gear button at the bottom right, and log in.

- **Update:** `git pull && ./install.sh --no-deps`, then log out and in.
- **Uninstall:** `./install.sh --uninstall`. Your settings stay in
  `~/.config/tessera`.

If Tessera doesn't start, log in with GNOME instead and look at its log:
`journalctl --user -b -u org.gnome.Shell@tessera.service`.

## Settings

Everything lives in `~/.config/tessera`: the tile layout (`tiles.json`),
the applets and their settings (`applets.json`), the desktop icons
(`desktop.json`, and where they are in `desktop-icons.json`), pinned app tiles
(`app-tiles.json`), the Clip (`clip.json`), the number of workspaces
(`workspaces.json`), their wallpapers (`wallpapers.json`), the workspace
sets (`sets.json`) and the Translator's languages and instructions
(`translator.json`). Copy the folder to take your desktop to another
machine.

## Hacking

`./run-nested.sh` builds, installs and runs Tessera in a window inside
your current session (`SIZE=1366x768 ./run-nested.sh` for another size).
It needs `sudo dnf install mutter-devkit`, and it shares `~/.local/tessera`
and `~/.config/tessera` with the real session. The tiles are in
`js/ui/dock/`; the applets in `js/ui/dock/docklets/`.

The upstream GNOME Shell README is in
[docs/upstream-README.md](docs/upstream-README.md).

## License

GPL-2.0-or-later, as GNOME Shell; see [COPYING](COPYING).

The colour icons of the Translator, Clipboard, Calculator and System applets
(`data/icons/scalable/actions/tessera-*.svg`) are from Microsoft's
[Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons),
MIT; see [data/icons/LICENSE.fluentui-system-icons](data/icons/LICENSE.fluentui-system-icons).
