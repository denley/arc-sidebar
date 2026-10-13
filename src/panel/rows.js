import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { isNewTabUrl } from '../shared/common.js';
import { dragSource, dropTarget } from './dnd.js';
import { Icon } from './icons.js';
import { bookmarkMenu, folderMenu, looseMenu, tabMenu } from './menus.js';
import { act } from './rpc.js';
import { cx, faviconFor, findActiveBookmark, prettyUrl, tabFavicon } from './util.js';

export function Favicon({ src, fallback, size = 16 }) {
  // Try the tab's own favicon, then Chrome's cached one, then a globe.
  const candidates = [src, fallback].filter((u, i, a) => u && a.indexOf(u) === i);
  const [stage, setStage] = useState(0);
  useEffect(() => setStage(0), [src, fallback]);
  const url = candidates[stage];
  if (!url) return html`<span class="favicon glyph"><${Icon} name="globe" size=${size - 2} /></span>`;
  return html`<img class="favicon" src=${url} width=${size} height=${size} alt="" draggable="false"
    onError=${() => setStage((s) => s + 1)} />`;
}

function TabIcon({ tab, url }) {
  if (tab && isNewTabUrl(tab.url)) return html`<span class="favicon glyph"><${Icon} name="search" size=${14} /></span>`;
  if (tab?.loading && !tab.favIconUrl) return html`<span class="favicon"><span class="spinner" /></span>`;
  return html`<${Favicon} src=${tab ? tabFavicon(tab) : faviconFor(url)} fallback=${faviconFor(url || tab?.url)} />`;
}

function RenameInput({ value, onCommit, onCancel }) {
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current.focus();
    ref.current.select();
  }, []);
  const finish = (save) => {
    if (done.current) return;
    done.current = true;
    save && ref.current.value.trim() && ref.current.value !== value ? onCommit(ref.current.value.trim()) : onCancel();
  };
  return html`<input class="rename" ref=${ref} value=${value} spellcheck="false"
    onKeyDown=${(e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    }}
    onBlur=${() => finish(true)} onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}
    onPointerDown=${(e) => e.stopPropagation()} draggable="false" />`;
}

export { RenameInput };

function AudioButton({ tab }) {
  if (!tab || (!tab.audible && !tab.muted)) return null;
  return html`
    <button class="row-btn audio" title=${tab.muted ? 'Unmute' : 'Mute'} tabindex="-1"
      onClick=${(e) => { e.stopPropagation(); act('toggleMute', { tabId: tab.id }); }}>
      <${Icon} name=${tab.muted ? 'mute' : 'volume'} size=${14} />
    </button>`;
}

function RowShell({ ui, rowKey, depth = 0, active, className, drag, drop, onActivate, onMiddle, onRename, onMenu, tooltip, children }) {
  const dropAt = ui.dropAt?.key === rowKey ? ui.dropAt.pos : null;
  const dragging = ui.drag && ui.drag.rowKey === rowKey;
  return html`
    <div class=${cx('row', active && 'active', dragging && 'dragging', dropAt && `drop-${dropAt}`, className)}
      style=${`--depth:${depth}`} tabindex="0" role="button" title=${tooltip} data-row=${rowKey}
      onClick=${onActivate}
      onMouseDown=${(e) => e.button === 1 && e.preventDefault()}
      onAuxClick=${(e) => { if (e.button === 1) { e.preventDefault(); onMiddle?.(); } }}
      onDblClick=${onRename}
      onContextMenu=${(e) => { e.preventDefault(); onMenu?.(e); }}
      onKeyDown=${(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') { e.preventDefault(); onActivate?.(e); }
        if (e.key === 'F2') { e.preventDefault(); onRename?.(); }
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu?.({ clientX: r.left + 24, clientY: r.bottom });
        }
      }}
      ...${drag || {}} ...${drop || {}}>
      ${children}
    </div>`;
}

export function BookmarkRow({ ui, node, parentId, index, depth, spaceId }) {
  const tab = node.tab;
  const key = `b:${node.id}`;
  const renaming = ui.renaming === key;
  const away = tab?.away;
  return html`
    <${RowShell} ui=${ui} rowKey=${key} depth=${depth} active=${tab?.active}
      className=${cx('bookmark', tab ? 'open' : 'closed', away && 'away', tab?.sleeping && 'sleeping')}
      tooltip=${away ? `${tab.title}\n${prettyUrl(tab.url)}\n\nPinned: ${node.title}` : `${node.title}\n${prettyUrl(node.url)}`}
      drag=${dragSource(ui, { kind: 'bookmark', id: node.id, url: node.url, title: node.title, rowKey: key })}
      drop=${dropTarget(ui, {
        key, zone: 'pinned',
        resolve: (pos) => ({ parentId, index: pos === 'before' ? index : index + 1 }),
      })}
      onActivate=${() => act('openBookmark', { id: node.id })}
      onMiddle=${() => tab && act('unloadBookmark', { id: node.id })}
      onRename=${() => ui.setRenaming(key)}
      onMenu=${(e) => ui.openMenu(e, bookmarkMenu(ui, node, { spaceId }))}>
      <span class="icon-slot">
        <${TabIcon} tab=${tab} url=${node.url} />
        ${away && html`
          <button class="reset" title="Back to pinned page" tabindex="-1"
            onClick=${(e) => { e.stopPropagation(); act('resetBookmark', { id: node.id }); }}>
            <${Icon} name="undo" size=${14} />
          </button>`}
      </span>
      <span class="title">
        ${renaming
          ? html`<${RenameInput} value=${node.title} onCancel=${() => ui.setRenaming(null)}
              onCommit=${(title) => { ui.setRenaming(null); act('renameBookmark', { id: node.id, title }); }} />`
          : away
            ? html`<span class="crumb">${node.title}</span><span class="crumb-sep">/</span><span>${tab.title}</span>`
            : node.title}
      </span>
      <${AudioButton} tab=${tab} />
      ${tab && html`
        <button class="row-btn close" title="Close tab (stays pinned)" tabindex="-1"
          onClick=${(e) => { e.stopPropagation(); act('unloadBookmark', { id: node.id }); }}>
          <${Icon} name="minus" size=${14} />
        </button>`}
    <//>`;
}

export function PinnedNodes({ ui, nodes, parentId, depth, spaceId }) {
  return nodes.map((n, i) => (n.kind === 'folder'
    ? html`<${FolderNode} key=${n.id} ui=${ui} node=${n} parentId=${parentId} index=${i} depth=${depth} spaceId=${spaceId} />`
    : html`<${BookmarkRow} key=${n.id} ui=${ui} node=${n} parentId=${parentId} index=${i} depth=${depth} spaceId=${spaceId} />`));
}

export function FolderNode({ ui, node, parentId, index, depth, spaceId }) {
  const key = `b:${node.id}`;
  const renaming = ui.renaming === key;
  const open = node.expanded;
  const peek = !open ? findActiveBookmark(node) : null;
  const toggle = () => act('toggleFolder', { id: node.id });
  return html`
    <div class="folder">
      <${RowShell} ui=${ui} rowKey=${key} depth=${depth} className=${cx('folder-row', open && 'expanded')}
        drag=${dragSource(ui, { kind: 'folder', id: node.id, title: node.title, rowKey: key })}
        drop=${dropTarget(ui, {
          key, zone: 'pinned', into: true,
          resolve: (pos, d) => {
            if (d.id === node.id) return null;
            if (pos === 'into') return { parentId: node.id };
            if (pos === 'before') return { parentId, index };
            return open ? { parentId: node.id, index: 0 } : { parentId, index: index + 1 };
          },
        })}
        onActivate=${toggle}
        onRename=${(e) => { e?.preventDefault?.(); ui.setRenaming(key); }}
        onMenu=${(e) => ui.openMenu(e, folderMenu(ui, node))}>
        <span class="icon-slot folder-icon">
          <${Icon} name=${open ? 'folderOpen' : 'folder'} size=${16} />
        </span>
        <span class="title">
          ${renaming
            ? html`<${RenameInput} value=${node.title} onCancel=${() => ui.setRenaming(null)}
                onCommit=${(title) => { ui.setRenaming(null); act('renameBookmark', { id: node.id, title }); }} />`
            : node.title}
        </span>
        <${Icon} name="chevron" size=${14} class="chevron" />
      <//>
      <div class=${cx('folder-children', open && 'open')} inert=${!open}>
        <div class="folder-inner">
          ${node.children.length
            ? html`<${PinnedNodes} ui=${ui} nodes=${node.children} parentId=${node.id} depth=${depth + 1} spaceId=${spaceId} />`
            : html`<div class="row empty-folder" style=${`--depth:${depth + 1}`}
                ...${dropTarget(ui, { key: `${key}:empty`, zone: 'pinned', resolve: () => ({ parentId: node.id }) })}>
                <span class="title">Empty folder</span>
              </div>`}
        </div>
      </div>
      ${peek && html`<${BookmarkRow} ui=${ui} node=${peek} parentId=${node.id} index=${node.children.indexOf(peek)} depth=${depth + 1} spaceId=${spaceId} />`}
    </div>`;
}

export function TabRow({ ui, tab, spaceId, nextTabId }) {
  const key = `t:${tab.id}`;
  const blank = isNewTabUrl(tab.url);
  return html`
    <${RowShell} ui=${ui} rowKey=${key} active=${tab.active}
      className=${cx('tab', tab.sleeping && 'sleeping')}
      tooltip=${blank ? 'New Tab' : `${tab.title}\n${prettyUrl(tab.url)}`}
      drag=${dragSource(ui, { kind: 'tab', id: tab.id, url: tab.url, title: tab.title, rowKey: key })}
      drop=${dropTarget(ui, {
        key, zone: 'today',
        resolve: (pos) => ({ spaceId, beforeTabId: pos === 'before' ? tab.id : nextTabId ?? null }),
      })}
      onActivate=${() => act('activateTab', { tabId: tab.id })}
      onMiddle=${() => act('closeTab', { tabId: tab.id })}
      onMenu=${(e) => ui.openMenu(e, tabMenu(ui, tab, spaceId))}>
      <span class="icon-slot"><${TabIcon} tab=${tab} url=${tab.url} /></span>
      <span class="title">${blank ? 'New Tab' : tab.title}</span>
      <${AudioButton} tab=${tab} />
      <button class="row-btn close" title="Close tab" tabindex="-1"
        onClick=${(e) => { e.stopPropagation(); act('closeTab', { tabId: tab.id }); }}>
        <${Icon} name="x" size=${14} />
      </button>
    <//>`;
}

export function Tile({ ui, item, index, favCount }) {
  const tab = item.tab;
  const key = `f:${item.id}`;
  const dropAt = ui.dropAt?.key === key ? ui.dropAt.pos : null;
  const isBookmark = item.kind === 'bookmark';
  const url = isBookmark ? item.url : tab.url;
  const label = isBookmark ? item.title : tab.title;
  const drag = dragSource(ui, isBookmark
    ? { kind: 'bookmark', id: item.id, url, title: label, rowKey: key }
    : { kind: 'loose', id: tab.id, url, title: label, rowKey: key });
  const drop = dropTarget(ui, {
    key, zone: 'fav', axis: 'x',
    resolve: (pos) => ({ index: isBookmark ? (pos === 'before' ? index : index + 1) : favCount }),
  });
  return html`
    <div class=${cx('tile', tab && 'open', tab?.active && 'active', !isBookmark && 'loose', dropAt && `drop-${dropAt}`)}
      role="button" tabindex="0" title=${`${label}\n${prettyUrl(tab?.url || url)}`}
      onClick=${() => (isBookmark ? act('openBookmark', { id: item.id }) : act('activateTab', { tabId: tab.id }))}
      onMouseDown=${(e) => e.button === 1 && e.preventDefault()}
      onAuxClick=${(e) => {
        if (e.button !== 1 || !tab) return;
        isBookmark ? act('unloadBookmark', { id: item.id }) : act('closeTab', { tabId: tab.id });
      }}
      onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.click()}
      onContextMenu=${(e) => { e.preventDefault(); ui.openMenu(e, isBookmark ? bookmarkMenu(ui, item, { inFavourites: true }) : looseMenu(ui, tab)); }}
      ...${drag} ...${drop}>
      <${Favicon} src=${tab ? tabFavicon(tab) : faviconFor(url)} fallback=${faviconFor(url)} size=${20} />
      ${tab?.audible && html`<span class="tile-badge"><${Icon} name=${tab.muted ? 'mute' : 'volume'} size=${10} /></span>`}
    </div>`;
}
