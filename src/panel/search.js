import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { normalizeUrl, toUrl } from '../shared/common.js';
import { Icon } from './icons.js';
import { act } from './rpc.js';
import { cx, faviconFor, prettyUrl, tabFavicon, walkPinned } from './util.js';
import { Favicon } from './rows.js';

// Arc-style command search: open tabs (every space), pinned tabs and
// favourites, history, and a URL / web search fallback.

function score(terms, title, url) {
  const t = (title || '').toLowerCase();
  const u = prettyUrl(url || '').toLowerCase();
  let s = 0;
  for (const term of terms) {
    if (t.startsWith(term)) s += 4;
    else if (t.split(/[\s\-–—|·:]+/).some((w) => w.startsWith(term))) s += 3;
    else if (u.startsWith(term)) s += 3;
    else if (t.includes(term)) s += 2;
    else if (u.includes(term)) s += 1;
    else return 0;
  }
  return s;
}

function buildResults(query, snap, history) {
  const q = query.trim();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const spaceById = Object.fromEntries(snap.spaces.map((s) => [s.id, s]));
  const seen = new Set();
  const tabs = [];
  const pinned = [];

  for (const f of snap.favourites) {
    const title = f.title || f.tab?.title;
    const url = f.url || f.tab?.url;
    const s = score(terms, title, f.tab?.url || url);
    if (!s) continue;
    if (f.kind === 'tab') tabs.push({ type: 'tab', key: `t${f.tab.id}`, tabId: f.tab.id, title, url, icon: tabFavicon(f.tab), badge: '★', s: s + 1 });
    else pinned.push({ type: 'bookmark', key: `b${f.id}`, id: f.id, title, url, icon: f.tab ? tabFavicon(f.tab) : faviconFor(url), badge: '★', open: !!f.tab, s: s + 1 });
  }
  for (const space of snap.spaces) {
    for (const t of space.today) {
      const s = score(terms, t.title, t.url);
      if (s) tabs.push({ type: 'tab', key: `t${t.id}`, tabId: t.id, title: t.title, url: t.url, icon: tabFavicon(t), badge: space.emoji, s });
    }
    walkPinned(space.pinned, space.id, (n) => {
      if (n.kind !== 'bookmark') return;
      const s = Math.max(score(terms, n.title, n.url), n.tab ? score(terms, n.tab.title, n.tab.url) : 0);
      if (s) pinned.push({ type: 'bookmark', key: `b${n.id}`, id: n.id, title: n.title, url: n.url, icon: n.tab ? tabFavicon(n.tab) : faviconFor(n.url), badge: spaceById[space.id]?.emoji, open: !!n.tab, s: s + 1 });
    });
  }
  tabs.sort((a, b) => b.s - a.s);
  pinned.sort((a, b) => b.s - a.s);
  for (const r of [...tabs, ...pinned]) seen.add(normalizeUrl(r.url));

  const hist = [];
  for (const h of history) {
    const n = normalizeUrl(h.url);
    if (seen.has(n) || !h.url.startsWith('http')) continue;
    seen.add(n);
    const s = score(terms, h.title, h.url);
    if (s) hist.push({ type: 'history', key: `h${h.id}`, url: h.url, title: h.title || prettyUrl(h.url), icon: faviconFor(h.url), s: s + Math.min(3, Math.log2(1 + (h.visitCount || 0)) / 2) });
  }
  hist.sort((a, b) => b.s - a.s);

  const asUrl = toUrl(q);
  const action = asUrl
    ? { type: 'url', key: 'url', url: asUrl, title: prettyUrl(asUrl), sub: 'Open' }
    : { type: 'web', key: 'web', text: q, title: q, sub: 'Search the web' };

  // Lead with the strongest match if it's a good one, then the URL/search.
  const best = [...tabs, ...pinned].sort((a, b) => b.s - a.s)[0];
  const lead = best && !asUrl && best.s >= 3 * terms.length ? [best] : [];
  const rest = (list, n) => list.filter((r) => r !== best || !lead.length).slice(0, n);
  return [
    ...lead,
    action,
    ...rest(tabs, 6).map((r) => ({ ...r, section: 'Tabs' })),
    ...rest(pinned, 6).map((r) => ({ ...r, section: 'Pinned' })),
    ...hist.slice(0, 8).map((r) => ({ ...r, section: 'History' })),
  ];
}

export function SearchResults({ ui, query, keysRef, done }) {
  const [history, setHistory] = useState([]);
  const [sel, setSel] = useState(0);
  const listRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const text = query.trim();
    const t = setTimeout(() => {
      chrome.history.search({ text, maxResults: 40, startTime: 0 }).then((r) => alive && setHistory(r));
    }, 50);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  const results = useMemo(() => buildResults(query, ui.snap, history), [query, ui.snap, history]);
  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.result.selected')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (r, e) => {
    if (!r) return;
    if (r.type === 'tab') act('activateTab', { tabId: r.tabId });
    else if (r.type === 'bookmark') act('openBookmark', { id: r.id });
    else if (r.type === 'web') act('searchWeb', { text: r.text });
    else act('newTab', { url: r.url });
    done();
  };

  keysRef.current = (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[sel], e);
    }
  };

  let lastSection = null;
  return html`
    <div class="results" ref=${listRef} role="listbox">
      ${results.map((r, i) => {
        const header = r.section && r.section !== lastSection ? html`<div class="section-label">${r.section}</div>` : null;
        lastSection = r.section || lastSection;
        const icon = r.type === 'web'
          ? html`<span class="result-glyph"><${Icon} name="search" /></span>`
          : r.type === 'url' ? html`<span class="result-glyph"><${Icon} name="goto" /></span>` : html`<${Favicon} src=${r.icon} />`;
        return html`
          ${header}
          <div class=${cx('result', i === sel && 'selected')} role="option" aria-selected=${i === sel}
            onPointerMove=${() => sel !== i && setSel(i)} onClick=${(e) => run(r, e)}>
            ${icon}
            <span class="result-text">
              <span class="result-title">${r.title}</span>
              <span class="result-sub">${r.sub || prettyUrl(r.url)}</span>
            </span>
            ${r.type === 'tab' && html`<span class="result-hint">Switch</span>`}
            ${r.badge && html`<span class="result-badge">${r.badge}</span>`}
          </div>`;
      })}
    </div>`;
}
