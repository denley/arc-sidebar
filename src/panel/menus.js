import { html, useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { act, call } from './rpc.js';
import { cx } from './util.js';
import { BookmarkDialog, ConfirmDialog, SettingsDialog, SpaceDialog } from './dialogs.js';

export function Menu({ x, y, items, onClose }) {
  const [stack, setStack] = useState([items]);
  const [pos, setPos] = useState(null);
  const ref = useRef(null);

  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    const left = Math.max(6, Math.min(x, innerWidth - r.width - 6));
    const top = y + r.height > innerHeight - 6 ? Math.max(6, y - r.height) : y;
    setPos({ left, top });
    ref.current.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true });
  }, [stack]);

  useEffect(() => {
    const down = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const blur = () => onClose();
    addEventListener('pointerdown', down, true);
    addEventListener('blur', blur);
    addEventListener('resize', blur);
    return () => {
      removeEventListener('pointerdown', down, true);
      removeEventListener('blur', blur);
      removeEventListener('resize', blur);
    };
  }, []);

  const onKeyDown = (e) => {
    const buttons = [...ref.current.querySelectorAll('.menu-item:not([disabled])')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      stack.length > 1 ? setStack(stack.slice(0, -1)) : onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
    } else if (e.key === 'ArrowLeft' && stack.length > 1) {
      setStack(stack.slice(0, -1));
    }
  };

  const list = stack[stack.length - 1].filter(Boolean);
  return html`
    <div class="menu" ref=${ref} role="menu" onKeyDown=${onKeyDown}
      style=${pos ? `left:${pos.left}px;top:${pos.top}px` : 'visibility:hidden'}>
      ${stack.length > 1 && html`
        <button class="menu-item back" onClick=${() => setStack(stack.slice(0, -1))}>
          <${Icon} name="back" /><span>Back</span>
        </button>
        <div class="menu-sep" />`}
      ${list.map((it, i) => (it === '-'
        ? (i > 0 && list[i - 1] !== '-' && i < list.length - 1 ? html`<div class="menu-sep" />` : null)
        : html`
          <button class=${cx('menu-item', it.danger && 'danger', it.checked && 'checked')} role="menuitem" disabled=${it.disabled}
            onClick=${() => {
              if (it.sub) return setStack([...stack, it.sub]);
              onClose();
              it.run?.();
            }}>
            <span class="menu-icon">${it.emoji ? html`<span class="menu-emoji">${it.emoji}</span>` : html`<${Icon} name=${it.icon || 'none'} />`}</span>
            <span class="menu-label">${it.label}</span>
            ${it.sub && html`<${Icon} name="chevron" class="menu-chevron" />`}
            ${it.checked && html`<${Icon} name="check" class="menu-chevron" />`}
          </button>`))}
    </div>`;
}

const copy = (text) => navigator.clipboard.writeText(text).catch(() => {});

function spaceTargets(ui, exceptId, run) {
  return ui.snap.spaces
    .filter((s) => s.id !== exceptId)
    .map((s) => ({ label: s.name, emoji: s.emoji || '•', run: () => run(s) }));
}

export function bookmarkMenu(ui, node, { inFavourites = false, spaceId } = {}) {
  const tab = node.tab;
  const others = spaceTargets(ui, inFavourites ? null : spaceId, (s) => act('moveBookmark', { id: node.id, parentId: s.id }));
  return [
    tab
      ? { label: 'Go to tab', icon: 'goto', run: () => act('openBookmark', { id: node.id }) }
      : { label: 'Open', icon: 'goto', run: () => act('openBookmark', { id: node.id }) },
    tab?.away && { label: 'Back to pinned page', icon: 'undo', run: () => act('resetBookmark', { id: node.id }) },
    tab?.away && { label: 'Pin this page instead', icon: 'pin', run: () => act('setBookmarkToCurrentUrl', { id: node.id }) },
    tab && { label: 'Close tab', icon: 'minus', run: () => act('unloadBookmark', { id: node.id }) },
    '-',
    !inFavourites && { label: 'Rename', icon: 'pencil', run: () => ui.setRenaming(`b:${node.id}`) },
    { label: 'Edit…', icon: 'bookmark', run: () => ui.openDialog(BookmarkDialog, { node }) },
    { label: 'Copy link', icon: 'link', run: () => copy(tab?.url || node.url) },
    '-',
    !inFavourites && { label: 'Add to favourites', icon: 'star', run: () => act('moveBookmark', { id: node.id, parentId: ui.snap.favouritesId }) },
    others.length && { label: inFavourites ? 'Move to space' : 'Move to another space', icon: 'arrowRight', sub: others },
    { label: inFavourites ? 'Remove from favourites' : 'Unpin', icon: 'pin', run: () => act('unpinBookmark', { id: node.id }), hidden: !tab },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: () => act('deleteBookmark', { id: node.id }) },
  ].filter((it) => it && !it.hidden);
}

export function tabMenu(ui, tab, spaceId) {
  const others = spaceTargets(ui, spaceId, (s) => act('moveToSpace', { kind: 'tab', id: tab.id, spaceId: s.id }));
  return [
    { label: 'Pin to space', icon: 'pin', run: () => act('pinTab', { tabId: tab.id }) },
    { label: 'Add to favourites', icon: 'star', run: () => act('pinTab', { tabId: tab.id, parentId: ui.snap.favouritesId }) },
    others.length && { label: 'Move to space', icon: 'arrowRight', sub: others },
    '-',
    { label: 'Copy link', icon: 'link', run: () => copy(tab.url) },
    { label: 'Duplicate', icon: 'copy', run: () => act('duplicateTab', { tabId: tab.id }) },
    { label: 'Reload', icon: 'refresh', run: () => act('reloadTab', { tabId: tab.id }) },
    (tab.audible || tab.muted) && { label: tab.muted ? 'Unmute' : 'Mute', icon: tab.muted ? 'volume' : 'mute', run: () => act('toggleMute', { tabId: tab.id }) },
    '-',
    { label: 'Close tab', icon: 'x', run: () => act('closeTab', { tabId: tab.id }) },
  ].filter(Boolean);
}

export function looseMenu(ui, tab) {
  return [
    { label: 'Save as favourite', icon: 'star', run: () => act('pinTab', { tabId: tab.id, parentId: ui.snap.favouritesId }) },
    { label: 'Unpin', icon: 'pin', run: () => act('unpinChromeTab', { tabId: tab.id }) },
    { label: 'Copy link', icon: 'link', run: () => copy(tab.url) },
    '-',
    { label: 'Close tab', icon: 'x', run: () => act('closeTab', { tabId: tab.id }) },
  ];
}

export function folderMenu(ui, folder) {
  const count = (n) => n.children.reduce((a, c) => a + (c.kind === 'folder' ? count(c) : 1), 0);
  const total = count(folder);
  return [
    { label: folder.expanded ? 'Collapse' : 'Expand', icon: folder.expanded ? 'folder' : 'folderOpen', run: () => act('toggleFolder', { id: folder.id }) },
    { label: 'Rename', icon: 'pencil', run: () => ui.setRenaming(`b:${folder.id}`) },
    { label: 'New folder inside', icon: 'folderPlus', run: () => newFolder(ui, folder.id) },
    '-',
    {
      label: 'Delete folder', icon: 'trash', danger: true,
      run: () => (total
        ? ui.openDialog(ConfirmDialog, {
          title: `Delete “${folder.title}”?`,
          message: `It has ${total} pinned ${total === 1 ? 'tab' : 'tabs'}. Any that are open stay in Today.`,
          confirm: 'Delete',
          run: () => act('deleteFolder', { id: folder.id }),
        })
        : act('deleteFolder', { id: folder.id })),
    },
  ];
}

export async function newFolder(ui, parentId) {
  const id = await call('createFolder', { parentId });
  ui.setRenaming(`b:${id}`);
}

export function spaceMenu(ui, space) {
  const spaces = ui.snap.spaces;
  const i = spaces.findIndex((s) => s.id === space.id);
  return [
    { label: 'Rename', icon: 'pencil', run: () => ui.setRenaming(`s:${space.id}`) },
    { label: 'Edit icon and colour…', icon: 'sliders', run: () => ui.openDialog(SpaceDialog, { space }) },
    '-',
    { label: 'New folder', icon: 'folderPlus', run: () => newFolder(ui, space.id) },
    { label: 'Pin a link…', icon: 'link', run: () => ui.openDialog(BookmarkDialog, { parentId: space.id }) },
    space.today.length && { label: 'Archive Today tabs', icon: 'archive', run: () => act('clearToday', { spaceId: space.id }) },
    '-',
    i > 0 && { label: 'Move left', icon: 'arrowLeft', run: () => act('moveSpace', { id: space.id, beforeId: spaces[i - 1].id }) },
    i < spaces.length - 1 && { label: 'Move right', icon: 'arrowRight', run: () => act('moveSpace', { id: space.id, beforeId: spaces[i + 2]?.id ?? null }) },
    { label: 'New space…', icon: 'plus', run: () => ui.openDialog(SpaceDialog, {}) },
    { label: 'Settings…', icon: 'sliders', run: () => ui.openDialog(SettingsDialog, {}) },
    '-',
    {
      label: 'Delete space…', icon: 'trash', danger: true, disabled: spaces.length < 2,
      run: () => ui.openDialog(ConfirmDialog, {
        title: `Delete ${space.emoji ? `${space.emoji} ` : ''}${space.name}?`,
        message: 'Its pinned tabs are deleted and its open tabs are closed. Closed tabs go to the archive.',
        confirm: 'Delete space',
        run: () => act('deleteSpace', { id: space.id }),
      }),
    },
  ].filter(Boolean);
}
