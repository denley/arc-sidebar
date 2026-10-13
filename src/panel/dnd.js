// Drag and drop between favourites, pinned bookmarks, Today tabs and the
// space switcher. Links dragged in from a web page work too.
//
// A drag item is { kind: 'bookmark' | 'folder' | 'tab' | 'loose' | 'link', id, url }
// ('loose' is a Chrome-pinned tab that isn't a saved favourite). A drop target
// is one of:
//   { zone: 'pinned', parentId, index }
//   { zone: 'fav', index }
//   { zone: 'today', spaceId, beforeTabId }
//   { zone: 'space', spaceId }

import { act } from './rpc.js';

const isTabLike = (d) => d.kind === 'tab' || d.kind === 'loose';

export const ACCEPTS = {
  pinned: () => true,
  fav: (d) => d.kind !== 'folder',
  today: (d) => d.kind !== 'folder',
  space: () => true,
};

function externalDrag(e) {
  const types = e.dataTransfer?.types || [];
  return types.includes('text/uri-list') ? { kind: 'link', external: true } : null;
}

function linkFrom(e) {
  const dt = e.dataTransfer;
  const url = (dt.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#')) || dt.getData('text/plain');
  const title = (dt.getData('text/html').match(/>([^<]+)</) || [])[1]?.trim();
  return { url: url?.trim(), title };
}

export function dragSource(ui, item) {
  return {
    draggable: true,
    onDragStart: (e) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'copyMove';
      if (item.url) {
        e.dataTransfer.setData('text/uri-list', item.url);
        e.dataTransfer.setData('text/plain', item.url);
      } else {
        e.dataTransfer.setData('text/plain', item.title || '');
      }
      // Let the browser grab the drag image before the UI changes underneath.
      requestAnimationFrame(() => ui.setDrag(item));
    },
    onDragEnd: () => {
      ui.setDrag(null);
      ui.setDropAt(null);
    },
  };
}

// key: identifies the indicator position; resolve(pos, drag) -> target | null.
// axis 'y' gives before/after by vertical half, 'x' by horizontal half;
// into: true adds a middle band that means "into this folder".
export function dropTarget(ui, { key, zone, resolve, axis = 'y', into = false }) {
  const posFrom = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = axis === 'y' ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    if (into && f > 0.25 && f < 0.75) return 'into';
    return f < 0.5 ? 'before' : 'after';
  };
  const current = (e) => ui.drag || externalDrag(e);
  return {
    onDragOver: (e) => {
      const d = current(e);
      if (!d || !ACCEPTS[zone](d)) return;
      const pos = posFrom(e);
      if (!resolve(pos, d)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = d.external ? 'copy' : 'move';
      ui.setDropAt((prev) => (prev?.key === key && prev?.pos === pos ? prev : { key, pos }));
    },
    onDrop: (e) => {
      const d = current(e);
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      const target = resolve(posFrom(e), d);
      ui.setDrag(null);
      ui.setDropAt(null);
      if (!target) return;
      perform(ui, d.external ? { kind: 'link', ...linkFrom(e) } : d, { zone, ...target });
    },
  };
}

export function perform(ui, d, t) {
  const favId = ui.snap.favouritesId;
  if (d.kind === 'link') {
    if (!d.url) return;
    if (t.zone === 'today') return act('newTab', { url: d.url, spaceId: t.spaceId });
    const parentId = t.zone === 'fav' ? favId : t.zone === 'space' ? t.spaceId : t.parentId;
    return act('addLink', { parentId, index: t.index, url: d.url, title: d.title });
  }
  switch (t.zone) {
    case 'pinned':
      if (isTabLike(d)) return act('pinTab', { tabId: d.id, parentId: t.parentId, index: t.index });
      if (d.id === t.parentId) return;
      return act('moveBookmark', { id: d.id, parentId: t.parentId, index: t.index });
    case 'fav':
      if (isTabLike(d)) return act('pinTab', { tabId: d.id, parentId: favId, index: t.index });
      return act('moveBookmark', { id: d.id, parentId: favId, index: t.index });
    case 'today':
      if (d.kind === 'tab') {
        if (d.id === t.beforeTabId) return;
        return act('reorderTab', { tabId: d.id, beforeTabId: t.beforeTabId, spaceId: t.spaceId });
      }
      if (d.kind === 'loose') return act('unpinChromeTab', { tabId: d.id, beforeTabId: t.beforeTabId });
      return act('unpinBookmark', { id: d.id, beforeTabId: t.beforeTabId });
    case 'space':
      return act('moveToSpace', { kind: isTabLike(d) ? 'tab' : 'bookmark', id: d.id, spaceId: t.spaceId });
  }
}
