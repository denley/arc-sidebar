# Arc Sidebar

An Arc-style sidebar for Chromium, as a side-panel extension. Favourites,
spaces of pinned tabs, and today's tabs in one vertical list, themed from the
current Omarchy theme.

## Install (Omarchy)

1. `tools/install` installs a `theme-set` hook so the sidebar follows the
   Omarchy theme.
2. In `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and pick this folder. It stays loaded across restarts. (Adding it
   to `--load-extension` in `chromium-flags.conf` doesn't work if Enhanced Safe
   Browsing is on: Chromium ignores that flag then.)
3. Press **Alt+S** or click the toolbar icon to open the sidebar.

To make Chrome's own tab strip mostly go away: right-click the tab strip, choose
**Show tabs vertically**, then collapse that strip to its narrow icon rail. Under
**Settings → Appearance**, set the side panel to the left so the sidebar sits
next to it.

On first run the sidebar is seeded from `seed.json` (curated from the Omarchy
menu bookmarks).

## How it works

| Arc | Here |
| --- | --- |
| Favourites (the icon grid) | Bookmarks in `Arc Sidebar/Favourites`. Open ones are Chrome-pinned tabs, so they stay put across spaces. |
| Spaces | The other folders in `Arc Sidebar`. The folder name carries the icon: `🏠 Home`. Each space's tabs are a Chrome tab group, and other spaces' groups are collapsed. |
| Pinned tabs | Bookmarks inside a space, with folders. Click to open; click again to jump back to the same tab. **–** closes the tab and keeps the pin. If you browse away, the row shows `Pin / Current page`. Hover the icon to go back. |
| Today | The space's other tabs, newest first. **Clear** archives them all. |
| Archive | Closed Today tabs, plus tabs you haven't looked at for 12 hours (configurable). Click to restore. |
| Command bar | The search box: open tabs in every space, pinned tabs, history, a URL, or a web search. Ctrl+K or `/` focuses it. |

Because it's all bookmarks, everything syncs with your Google account and can
also be edited in Chrome's bookmark manager.

### Mouse and keyboard

- Drag to rearrange anything. Drag a Today tab up into pinned to pin it, or
  down to unpin. Drop it on favourites, or on a space icon at the bottom to
  move it there. You can also drag links in from a page.
- Swipe left or right with two fingers to change space. **Alt+Shift+←/→** does
  the same from anywhere.
- **Alt+T**: new tab in the current space.
- Double-click (or F2) to rename a pinned tab, folder or space. Middle-click
  closes a tab. Right-click for everything else.
- More shortcuts (pin/unpin the current tab, archive it, open the sidebar and
  search) can be set at `chrome://extensions/shortcuts`.

## Limits

- Chrome doesn't let extensions hide its toolbar or tab strip. Collapsed
  vertical tabs are as close as it gets.
- Chrome only opens the side panel after a click or shortcut, so a new window
  needs **Alt+S** once.
- Ctrl+T is Chrome's. Alt+T opens a new tab in the space; the search box covers
  Arc's command bar.

## Development

```sh
node tools/test.mjs          # engine behaviour tests in a throwaway headless Chromium
node tools/dev.mjs           # screenshot the panel to /tmp/arc-sidebar.png
```

After editing files, reload the extension at `chrome://extensions`. The panel
alone reloads with Ctrl+R while it's focused.

`src/background/engine.js` owns all state and does every tab, group and
bookmark change through a serial queue. `src/panel/` is a Preact (htm, no build
step) UI that renders the snapshots it pushes.
