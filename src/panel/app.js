import { html, render, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { ArchiveView } from './archive.js';
import { SpaceDialog } from './dialogs.js';
import { dropTarget } from './dnd.js';
import { Icon } from './icons.js';
import { Menu, newFolder, spaceMenu } from './menus.js';
import { act, onFocusSearch, onSnapshot, start } from './rpc.js';
import { PinnedNodes, RenameInput, TabRow, Tile } from './rows.js';
import { SearchResults } from './search.js';
import { loadOmarchyTheme, themeVars } from './theme.js';
import { cx } from './util.js';

function App() {
  const [snap, setSnap] = useState(null);
  const [override, setOverride] = useState(null); // optimistic space switch { id, at }
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [drag, setDrag] = useState(null);
  const [dropAt, setDropAt] = useState(null);
  const [view, setView] = useState('spaces');
  const [query, setQuery] = useState('');
  const [themeTick, setThemeTick] = useState(0);
  const searchRef = useRef(null);
  const searchKeys = useRef(null);

  useEffect(() => onSnapshot(setSnap), []);
  useEffect(() => onFocusSearch(() => {
    window.focus();
    setView('spaces');
    searchRef.current?.focus();
    searchRef.current?.select();
  }), []);

  // Follow the Omarchy theme live (the hook rewrites theme/omarchy.json).
  useEffect(() => {
    const check = () => loadOmarchyTheme().then((changed) => changed && setThemeTick((t) => t + 1));
    check();
    const timer = setInterval(() => document.visibilityState === 'visible' && check(), 2000);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => setThemeTick((t) => t + 1);
    mq.addEventListener('change', onScheme);
    return () => { clearInterval(timer); mq.removeEventListener('change', onScheme); };
  }, []);

  const viewSpaceId = override && Date.now() - override.at < 2500 && snap?.spaces.some((s) => s.id === override.id)
    ? override.id
    : snap?.activeSpaceId;
  useEffect(() => {
    if (override && snap?.activeSpaceId === override.id) setOverride(null);
  }, [snap?.activeSpaceId]);

  const space = snap?.spaces.find((s) => s.id === viewSpaceId) || snap?.spaces[0];

  useLayoutEffect(() => {
    const vars = themeVars(space?.color || 'blue');
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.style.colorScheme = vars['--scheme'];
  }, [space?.color, themeTick]);

  const ui = useMemo(() => ({
    snap,
    viewSpaceId,
    renaming,
    setRenaming,
    drag,
    setDrag,
    dropAt,
    setDropAt,
    switchSpace(id) {
      if (id === viewSpaceId) return;
      setOverride({ id, at: Date.now() });
      setView('spaces');
      act('switchSpace', { spaceId: id });
    },
    openMenu(e, items) {
      setMenu({ x: e.clientX, y: e.clientY, items, key: Date.now() });
    },
    openDialog(type, props = {}) {
      setMenu(null);
      setDialog({ type, props });
    },
    focusSearch() {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
  }), [snap, viewSpaceId, renaming, drag, dropAt]);

  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === 'l' && e.ctrlKey) || (e.key === '/' && !typing)) {
        e.preventDefault();
        ui.focusSearch();
      } else if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !menu && !dialog) {
        const rows = [...document.querySelectorAll('.page.current .row[tabindex], .favs .tile, .results .result')];
        const i = rows.indexOf(document.activeElement);
        const next = rows[i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) { e.preventDefault(); next.focus(); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [ui, menu, dialog]);

  if (!snap) return html`<div class="app loading" />`;

  const searching = query.trim().length > 0;
  return html`
    <div class=${cx('app', drag && 'is-dragging')}
      onDragOver=${() => dropAt && setDropAt(null)}
      onContextMenu=${(e) => !/^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.preventDefault()}>
      <header class="top">
        <label class="search">
          <${Icon} name="search" size=${15} />
          <input ref=${searchRef} placeholder="Search or enter URL" value=${query} spellcheck="false"
            onInput=${(e) => setQuery(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === 'Escape') { setQuery(''); e.target.blur(); } else searchKeys.current?.(e);
            }} />
          ${query && html`<button class="icon-btn small" title="Clear" onClick=${() => setQuery('')}><${Icon} name="x" size=${14} /></button>`}
        </label>
      </header>
      ${searching
        ? html`<${SearchResults} ui=${ui} query=${query} keysRef=${searchKeys}
            done=${() => { setQuery(''); searchRef.current?.blur(); }} />`
        : view === 'archive'
          ? html`<${ArchiveView} ui=${ui} onBack=${() => setView('spaces')} />`
          : html`
            <${Favourites} ui=${ui} />
            <${Pager} ui=${ui} />`}
      <${BottomBar} ui=${ui} view=${view} setView=${setView} />
      ${menu && html`<${Menu} key=${menu.key} x=${menu.x} y=${menu.y} items=${menu.items} onClose=${() => setMenu(null)} />`}
      ${dialog && html`<${dialog.type} ...${dialog.props} ui=${ui} settings=${snap.settings} onClose=${() => setDialog(null)} />`}
    </div>`;
}

function Favourites({ ui }) {
  const favs = ui.snap.favourites;
  if (!favs.length && !ui.drag) return null;
  const n = favs.length;
  const cols = n <= 4 ? Math.max(n, 1) : Math.min(5, Math.ceil(n / Math.ceil(n / 5)));
  const favCount = favs.filter((f) => f.kind === 'bookmark').length;
  return html`
    <section class=${cx('favs', !n && 'empty', ui.dropAt?.key === 'favs' && 'drop-into')}
      style=${`grid-template-columns: repeat(${cols}, minmax(0, 1fr))`}
      ...${dropTarget(ui, { key: 'favs', zone: 'fav', resolve: () => ({ index: favCount }) })}>
      ${favs.map((f, i) => html`<${Tile} key=${f.id} ui=${ui} item=${f} index=${i} favCount=${favCount} />`)}
      ${!n && html`<div class="fav-hint"><${Icon} name="star" size=${14} /> Drop here to add a favourite</div>`}
    </section>`;
}

// Horizontal pager of spaces. Two-finger horizontal swipes drag it; past a
// third of the width it flips to the neighbouring space.
function Pager({ ui }) {
  const spaces = ui.snap.spaces;
  const idx = Math.max(0, spaces.findIndex((s) => s.id === ui.viewSpaceId));
  const [offset, setOffset] = useState(0);
  const ref = useRef(null);
  const swipe = useRef({ acc: 0, timer: null, locked: false });
  const latest = useRef({ idx, spaces, ui });
  latest.current = { idx, spaces, ui };

  useEffect(() => {
    const el = ref.current;
    const onWheel = (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || e.ctrlKey) return;
      e.preventDefault();
      const s = swipe.current;
      clearTimeout(s.timer);
      s.timer = setTimeout(() => {
        s.acc = 0;
        s.locked = false;
        setOffset(0);
      }, 160);
      if (s.locked) return;
      const { idx: i, spaces: list, ui: u } = latest.current;
      s.acc += e.deltaX;
      const w = el.clientWidth;
      const atEdge = (s.acc < 0 && i === 0) || (s.acc > 0 && i === list.length - 1);
      setOffset(-s.acc * (atEdge ? 0.25 : 1));
      if (!atEdge && Math.abs(s.acc) > w / 3) {
        s.locked = true;
        s.acc = 0;
        setOffset(0);
        u.switchSpace(list[i + (e.deltaX > 0 ? 1 : -1)].id);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return html`
    <div class="pager" ref=${ref}>
      <div class=${cx('track', offset !== 0 && 'swiping')}
        style=${`transform: translateX(calc(${-idx * 100}% + ${offset}px))`}>
        ${spaces.map((s) => html`<${SpacePage} key=${s.id} ui=${ui} space=${s} current=${s.id === ui.viewSpaceId} />`)}
      </div>
    </div>`;
}

function SpacePage({ ui, space, current }) {
  const renaming = ui.renaming === `s:${space.id}`;
  const pinnedEmpty = !space.pinned.length;
  const lastTab = space.today.at(-1);
  return html`
    <div class=${cx('page', current && 'current')} inert=${!current}
      onContextMenu=${(e) => { if (e.target === e.currentTarget || e.target.classList.contains('page-fill')) { e.preventDefault(); ui.openMenu(e, spaceMenu(ui, space)); } }}>
      <div class="space-header" onDblClick=${() => ui.setRenaming(`s:${space.id}`)}
        onContextMenu=${(e) => { e.preventDefault(); ui.openMenu(e, spaceMenu(ui, space)); }}>
        ${space.emoji && html`<span class="space-emoji">${space.emoji}</span>`}
        <span class="space-name">
          ${renaming
            ? html`<${RenameInput} value=${space.name} onCancel=${() => ui.setRenaming(null)}
                onCommit=${(name) => { ui.setRenaming(null); act('updateSpace', { id: space.id, name, emoji: space.emoji }); }} />`
            : space.name}
        </span>
        <button class="icon-btn small" title="New folder" onClick=${() => newFolder(ui, space.id)}>
          <${Icon} name="folderPlus" size=${15} />
        </button>
        <button class="icon-btn small" title="Space options"
          onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); ui.openMenu({ clientX: r.left, clientY: r.bottom + 4 }, spaceMenu(ui, space)); }}>
          <${Icon} name="more" size=${16} />
        </button>
      </div>

      <div class="pinned">
        <${PinnedNodes} ui=${ui} nodes=${space.pinned} parentId=${space.id} depth=${0} spaceId=${space.id} />
        <div class=${cx('pinned-end', pinnedEmpty && 'empty', ui.dropAt?.key === `pinned-end:${space.id}` && 'drop-into')}
          ...${dropTarget(ui, { key: `pinned-end:${space.id}`, zone: 'pinned', resolve: () => ({ parentId: space.id }) })}>
          ${pinnedEmpty && html`<span><${Icon} name="pin" size=${13} /> Drag tabs here to pin them</span>`}
        </div>
      </div>

      <div class="divider" ...${dropTarget(ui, { key: `today-top:${space.id}`, zone: 'today', resolve: () => ({ spaceId: space.id, beforeTabId: space.today[0]?.id ?? null }) })}>
        <span class="divider-line" />
        ${space.today.length > 0 && html`
          <button class="clear" title="Archive all Today tabs in this space"
            onClick=${() => act('clearToday', { spaceId: space.id })}>
            <${Icon} name="arrowDown" size=${12} /> Clear
          </button>`}
      </div>

      <div class="today">
        <div class=${cx('row new-tab', ui.dropAt?.key === `today-top:${space.id}` && 'drop-after')} role="button" tabindex="0"
          onClick=${() => act('newTab', { spaceId: space.id })}
          onKeyDown=${(e) => e.key === 'Enter' && act('newTab', { spaceId: space.id })}>
          <span class="icon-slot"><${Icon} name="plus" size=${16} /></span>
          <span class="title">New Tab</span>
        </div>
        ${space.today.map((t, i) => html`
          <${TabRow} key=${t.id} ui=${ui} tab=${t} spaceId=${space.id} nextTabId=${space.today[i + 1]?.id} />`)}
        <div class=${cx('page-fill', ui.dropAt?.key === `today-end:${space.id}` && lastTab && 'drop-top')}
          ...${dropTarget(ui, { key: `today-end:${space.id}`, zone: 'today', resolve: () => ({ spaceId: space.id, beforeTabId: null }) })} />
      </div>
    </div>`;
}

function BottomBar({ ui, view, setView }) {
  const spaces = ui.snap.spaces;
  return html`
    <footer class="bottom">
      <button class=${cx('icon-btn', view === 'archive' && 'on')} title="Archive"
        onClick=${() => setView(view === 'archive' ? 'spaces' : 'archive')}>
        <${Icon} name="archive" size=${16} />
      </button>
      <div class="space-dots" role="tablist">
        ${spaces.map((s) => {
          const key = `space:${s.id}`;
          const current = s.id === ui.viewSpaceId && view === 'spaces';
          return html`
            <button key=${s.id} role="tab" aria-selected=${current} title=${s.name}
              class=${cx('space-dot', current && 'current', ui.dropAt?.key === key && 'drop-into')}
              style=${`--dot:var(--dot-${s.color})`}
              onClick=${() => { setView('spaces'); ui.switchSpace(s.id); }}
              onContextMenu=${(e) => { e.preventDefault(); ui.openMenu(e, spaceMenu(ui, s)); }}
              ...${dropTarget(ui, { key, zone: 'space', resolve: () => ({ spaceId: s.id }) })}>
              ${s.emoji ? html`<span class="dot-emoji">${s.emoji}</span>` : html`<span class="dot" data-color=${s.color} />`}
            </button>`;
        })}
      </div>
      <button class="icon-btn" title="New space" onClick=${() => ui.openDialog(SpaceDialog, {})}>
        <${Icon} name="plus" size=${16} />
      </button>
    </footer>`;
}

const params = new URLSearchParams(location.search);
const windowId = params.has('window') ? Number(params.get('window')) : (await chrome.windows.getCurrent()).id;
await start(windowId);
render(html`<${App} />`, document.getElementById('root'));
