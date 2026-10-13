// The engine owns all state and is the only thing that mutates tabs, groups
// and bookmarks. The panel renders snapshots and asks for changes through the
// API at the bottom of this class.
//
// Model:
//   - Bookmarks folder "Arc Sidebar" holds a "Favourites" folder plus one
//     folder per space. The space folder's title carries its emoji ("🏠 Home").
//   - Every unpinned tab in a normal window belongs to a space through a
//     Chrome tab group. Favourite tabs are Chrome-pinned tabs (global, like Arc).
//   - A tab can be "bound" to a bookmark: that's a pinned bookmark that is
//     currently open. Bindings live in session storage and are re-made by URL
//     after a browser restart.
//
// Every event handler and API call runs through a serial queue, so tasks never
// interleave and each one can read-then-write chrome state safely.

import {
  ARCHIVE_LIMIT, DEFAULT_SETTINGS, FAVOURITES_TITLE, ROOT_TITLE, SPACE_COLORS,
  formatSpaceTitle, isAway, isNewTabUrl, normalizeUrl, parseSpaceTitle, sameSite,
} from '../shared/common.js';

const NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE
const byRecent = (a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0);
// Where a tab is or is about to be; url is empty while the first load is pending.
const urlOf = (t) => t?.pendingUrl || t?.url || '';
const isBlank = (t) => { const u = urlOf(t); return !!u && isNewTabUrl(u); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  constructor() {
    this.chain = Promise.resolve();
    this.ports = new Map(); // port -> windowId
    this.windowTypes = new Map();
    this.tabCache = new Map(); // tabId -> last known tab
    this.removed = new Map(); // tabId -> tab, for tabs closed in the last few seconds
    this.treeCache = null;
    this.publishTimer = null;
    this.startingUp = false;
    this.lastFocusedWindow = null;
    this.ready = this.load();
  }

  // --- Plumbing --------------------------------------------------------------

  async load() {
    const { state } = await chrome.storage.session.get('state');
    this.s = {
      bindings: {}, // tabId -> bookmarkId
      landing: {}, // tabId -> URL a bound tab first settled on
      groupSpace: {}, // groupId -> spaceId
      primary: {}, // windowId -> { spaceId -> groupId } (where new tabs go)
      activeSpace: {}, // windowId -> spaceId
      activeTab: {}, // windowId -> tabId
      lastTab: {}, // windowId -> { spaceId -> tabId }
      ...state,
    };
    const local = await chrome.storage.local.get(null);
    this.l = {
      rootId: null,
      favouritesId: null,
      spaceMeta: {}, // spaceId -> { color }
      expanded: {}, // folderId -> bool
      lastBound: {}, // bookmarkId -> URL its tab was last on
      spaceUrls: {}, // spaceId -> URLs open in it (restart recovery)
      archive: [],
      ...local,
      settings: { ...DEFAULT_SETTINGS, ...(local.settings || {}) },
    };
    const windows = await chrome.windows.getAll({ populate: true });
    for (const w of windows) {
      this.windowTypes.set(w.id, w.type);
      for (const t of w.tabs || []) this.tabCache.set(t.id, t);
      if (w.focused) this.lastFocusedWindow = w.id;
    }
  }

  enqueue(fn, { publish = true } = {}) {
    const job = this.chain.then(() => this.ready).then(fn);
    this.chain = job.then(
      () => this.afterTask(publish),
      (e) => { console.error('[arc-sidebar]', e); return this.afterTask(publish); },
    );
    return job;
  }

  async afterTask(publish) {
    await chrome.storage.session.set({ state: this.s });
    if (publish) this.schedulePublish();
  }

  saveLocal(...keys) {
    return chrome.storage.local.set(Object.fromEntries(keys.map((k) => [k, this.l[k]])));
  }

  schedulePublish(delay = 30) {
    if (!this.ports.size || this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.enqueue(() => this.publishNow(), { publish: false });
    }, delay);
  }

  async publishNow() {
    const windowIds = new Set(this.ports.values());
    for (const windowId of windowIds) {
      let snapshot;
      try {
        await this.reconcile(windowId);
        snapshot = await this.snapshot(windowId);
      } catch (e) {
        console.error('[arc-sidebar] snapshot', e);
        continue;
      }
      for (const [port, w] of this.ports) {
        if (w !== windowId) continue;
        try { port.postMessage({ type: 'snapshot', snapshot }); } catch { this.ports.delete(port); }
      }
    }
  }

  onConnect(port) {
    port.onMessage.addListener((msg) => this.onPortMessage(port, msg));
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  onPortMessage(port, msg) {
    if (msg.type === 'hello') {
      this.ports.set(port, msg.windowId);
      this.schedulePublish(0);
    } else if (msg.type === 'call') {
      const fn = this.api[msg.name];
      const reply = (body) => { try { port.postMessage({ type: 'result', id: msg.id, ...body }); } catch {} };
      if (!fn) return reply({ ok: false, error: `unknown call ${msg.name}` });
      this.call(msg.name, msg.args || {}).then(
        (value) => reply({ ok: true, value }),
        (e) => reply({ ok: false, error: String(e?.message || e) }),
      );
    }
  }

  call(name, args) {
    return this.enqueue(async () => {
      try {
        return await this.api[name].call(this, args);
      } finally {
        this.treeCache = null;
      }
    });
  }

  async isManaged(windowId) {
    if (windowId == null || windowId < 0) return false;
    if (!this.windowTypes.has(windowId)) {
      try {
        this.windowTypes.set(windowId, (await chrome.windows.get(windowId)).type);
      } catch {
        return false;
      }
    }
    return this.windowTypes.get(windowId) === 'normal';
  }

  async managedWindowIds() {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    for (const w of windows) this.windowTypes.set(w.id, w.type);
    return windows.map((w) => w.id);
  }

  // --- Bookmarks ---------------------------------------------------------------

  async getRoot() {
    if (this.l.rootId) {
      try {
        const [n] = await chrome.bookmarks.get(this.l.rootId);
        if (n && !n.url) return n;
      } catch {}
    }
    const found = (await chrome.bookmarks.search({ title: ROOT_TITLE })).find((n) => !n.url);
    if (found) {
      this.l.rootId = found.id;
      await this.saveLocal('rootId');
    }
    return found || null;
  }

  async seed() {
    const [tree] = await chrome.bookmarks.getTree();
    const other = tree.children.find((c) => c.folderType === 'other') || tree.children[1] || tree.children[0];
    const root = await chrome.bookmarks.create({ parentId: other.id, title: ROOT_TITLE });
    // seed.json only on the very first run; if the folder is deleted later,
    // start again empty rather than resurrecting the seed bookmarks.
    let seed = { favourites: [], spaces: [{ title: '🌿 Personal', color: 'green', items: [] }] };
    if (!this.l.seeded) {
      try {
        seed = await (await fetch(chrome.runtime.getURL('seed.json'))).json();
      } catch {}
    }
    const fav = await chrome.bookmarks.create({ parentId: root.id, title: FAVOURITES_TITLE });
    for (const f of seed.favourites || []) await chrome.bookmarks.create({ parentId: fav.id, title: f.title, url: f.url });
    const add = async (parentId, items) => {
      for (const it of items || []) {
        if (it.children) {
          const folder = await chrome.bookmarks.create({ parentId, title: it.title });
          await add(folder.id, it.children);
        } else {
          await chrome.bookmarks.create({ parentId, title: it.title, url: it.url });
        }
      }
    };
    for (const s of seed.spaces || []) {
      const folder = await chrome.bookmarks.create({ parentId: root.id, title: s.title });
      if (s.color) this.l.spaceMeta[folder.id] = { color: s.color };
      await add(folder.id, s.items);
    }
    Object.assign(this.l, { rootId: root.id, favouritesId: fav.id, seeded: true });
    await this.saveLocal('rootId', 'favouritesId', 'spaceMeta', 'seeded');
    this.treeCache = null;
    return root;
  }

  async tree() {
    if (this.treeCache) return this.treeCache;
    let root = await this.getRoot();
    if (!root) root = await this.seed();
    let [rootNode] = await chrome.bookmarks.getSubTree(root.id);
    const kids = rootNode.children || [];
    let fav = kids.find((c) => !c.url && c.id === this.l.favouritesId) || kids.find((c) => !c.url && c.title === FAVOURITES_TITLE);
    let created = false;
    if (!fav) {
      await chrome.bookmarks.create({ parentId: root.id, title: FAVOURITES_TITLE, index: 0 });
      created = true;
    }
    if (!kids.some((c) => !c.url && c.id !== fav?.id)) {
      await chrome.bookmarks.create({ parentId: root.id, title: '🌿 Personal' });
      created = true;
    }
    if (created) {
      [rootNode] = await chrome.bookmarks.getSubTree(root.id);
      fav = rootNode.children.find((c) => !c.url && c.title === FAVOURITES_TITLE);
    }
    if (fav.id !== this.l.favouritesId) {
      this.l.favouritesId = fav.id;
      await this.saveLocal('favouritesId');
    }
    const folders = rootNode.children.filter((c) => !c.url && c.id !== fav.id);
    const spaces = folders.map((node, i) => ({
      id: node.id,
      title: node.title,
      ...parseSpaceTitle(node.title),
      color: this.l.spaceMeta[node.id]?.color || SPACE_COLORS[i % SPACE_COLORS.length],
      node,
    }));
    const bookmarks = new Map(); // id -> { node, owner: spaceId | 'fav' }
    const walk = (n, owner) => {
      for (const c of n.children || []) {
        bookmarks.set(c.id, { node: c, owner });
        if (!c.url) walk(c, owner);
      }
    };
    walk(fav, 'fav');
    for (const s of spaces) walk(s.node, s.id);
    this.treeCache = { root: rootNode, fav, spaces, bookmarks };
    return this.treeCache;
  }

  ownerOf(tree, folderId) {
    if (folderId === tree.fav.id) return 'fav';
    if (tree.spaces.some((s) => s.id === folderId)) return folderId;
    return tree.bookmarks.get(folderId)?.owner ?? null;
  }

  // --- Spaces and groups -------------------------------------------------------

  spaceOfTab(tab) {
    if (!tab || tab.pinned || tab.groupId === NONE || tab.groupId == null) return null;
    return this.s.groupSpace[tab.groupId] ?? null;
  }

  async activeSpaceFor(windowId) {
    const tree = await this.tree();
    const valid = (id) => tree.spaces.some((s) => s.id === id);
    let id = this.s.activeSpace[windowId];
    if (valid(id)) return id;
    const [active] = await chrome.tabs.query({ windowId, active: true });
    id = this.spaceOfTab(active);
    if (!valid(id)) id = this.s.activeSpace[this.lastFocusedWindow];
    if (!valid(id)) id = tree.spaces[0].id;
    this.s.activeSpace[windowId] = id;
    return id;
  }

  async groupFor(windowId, spaceId) {
    const prim = (this.s.primary[windowId] ||= {});
    const gid = prim[spaceId];
    if (gid == null) return null;
    try {
      await chrome.tabGroups.get(gid);
      return gid;
    } catch {
      delete prim[spaceId];
      return null;
    }
  }

  // Put tabs into a space's group in their window, creating the group if needed.
  async addToSpace(tabIds, windowId, spaceId, { top = this.l.settings.newTabsOnTop } = {}) {
    if (!tabIds.length) return null;
    const tree = await this.tree();
    const space = tree.spaces.find((s) => s.id === spaceId) || tree.spaces[0];
    let gid = await this.groupFor(windowId, space.id);
    if (gid == null) {
      gid = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      this.s.primary[windowId][space.id] = gid;
      this.s.groupSpace[gid] = space.id;
      const collapsed = this.l.settings.collapseOtherSpaces && space.id !== this.s.activeSpace[windowId];
      await chrome.tabGroups.update(gid, { title: space.title, color: space.color });
      if (collapsed) await chrome.tabGroups.update(gid, { collapsed: true }).catch(() => {});
      return gid;
    }
    await chrome.tabs.group({ tabIds, groupId: gid });
    if (top) await this.moveToTopOfGroup(tabIds, gid);
    return gid;
  }

  async moveToTopOfGroup(tabIds, gid) {
    const inGroup = await chrome.tabs.query({ groupId: gid });
    if (!inGroup.length) return;
    const first = Math.min(...inGroup.map((t) => t.index));
    await chrome.tabs.move(tabIds, { index: first });
  }

  async createTab(windowId, spaceId, { url, active = true, pinned = false } = {}) {
    const tab = await chrome.tabs.create({ windowId, url, active, pinned });
    this.tabCache.set(tab.id, tab);
    if (!pinned) await this.addToSpace([tab.id], windowId, spaceId ?? (await this.activeSpaceFor(windowId)), { top: true });
    return tab;
  }

  async collapseOthers(windowId) {
    if (!this.l.settings.collapseOtherSpaces) return;
    const active = this.s.activeSpace[windowId];
    for (const g of await chrome.tabGroups.query({ windowId })) {
      const own = this.s.groupSpace[g.id] === active;
      if (g.collapsed === own) await chrome.tabGroups.update(g.id, { collapsed: !own }).catch(() => {});
    }
  }

  async closeBlankTabs(windowId, spaceId) {
    const tabs = await chrome.tabs.query({ windowId });
    const blank = tabs.filter((t) => !t.active && this.spaceOfTab(t) === spaceId && !this.s.bindings[t.id] && isBlank(t));
    if (blank.length) await chrome.tabs.remove(blank.map((t) => t.id));
  }

  async switchSpace(windowId, spaceId, { focus = true } = {}) {
    const tree = await this.tree();
    if (!tree.spaces.some((s) => s.id === spaceId)) return;
    const prev = this.s.activeSpace[windowId];
    this.s.activeSpace[windowId] = spaceId;
    const tabs = await chrome.tabs.query({ windowId });
    const current = tabs.find((t) => t.active);
    const currentSpace = this.spaceOfTab(current);
    if (currentSpace) (this.s.lastTab[windowId] ||= {})[currentSpace] = current.id;
    if (focus) {
      if (currentSpace !== spaceId) {
        const own = tabs.filter((t) => this.spaceOfTab(t) === spaceId);
        const remembered = own.find((t) => t.id === this.s.lastTab[windowId]?.[spaceId]);
        const target = remembered || own.sort(byRecent)[0];
        if (target) await chrome.tabs.update(target.id, { active: true });
        else if (!current?.pinned) await this.createTab(windowId, spaceId);
      }
    }
    if (prev && prev !== spaceId) await this.closeBlankTabs(windowId, prev);
    await this.collapseOthers(windowId);
  }

  // Before closing or moving the active tab, activate something else in the
  // same space so Chrome doesn't wander into another space's group.
  async keepFocusInSpace(windowId, leavingTabIds) {
    const tabs = await chrome.tabs.query({ windowId });
    const active = tabs.find((t) => t.active);
    if (!active || !leavingTabIds.includes(active.id)) return;
    const sid = this.spaceOfTab(active) ?? this.s.activeSpace[windowId];
    const rest = tabs.filter((t) => !leavingTabIds.includes(t.id) && this.spaceOfTab(t) === sid);
    if (rest.length) {
      // Prefer the neighbour below in the sidebar, like closing a tab in Arc.
      const below = rest.filter((t) => t.index > active.index).sort((a, b) => a.index - b.index)[0];
      await chrome.tabs.update((below || rest.sort(byRecent)[0]).id, { active: true });
    } else if (sid) {
      await this.createTab(windowId, sid);
    }
  }

  async closeTabs(windowId, tabIds) {
    if (!tabIds.length) return;
    await this.keepFocusInSpace(windowId, tabIds);
    await chrome.tabs.remove(tabIds);
  }

  bind(tabId, bookmarkId, url) {
    for (const [t, b] of Object.entries(this.s.bindings)) if (b === bookmarkId && +t !== tabId) delete this.s.bindings[t];
    this.s.bindings[tabId] = bookmarkId;
    delete this.s.landing[tabId];
    if (url) this.l.lastBound[bookmarkId] = url;
  }

  // A bound tab must live where its bookmark lives: favourites are Chrome-pinned,
  // space bookmarks are unpinned and in that space's group.
  async placeTab(tab, owner) {
    if (owner === 'fav') {
      if (!tab.pinned) await chrome.tabs.update(tab.id, { pinned: true });
      return;
    }
    if (tab.pinned) await chrome.tabs.update(tab.id, { pinned: false });
    const fresh = await chrome.tabs.get(tab.id);
    if (this.spaceOfTab(fresh) !== owner) {
      if (fresh.active && owner !== this.s.activeSpace[fresh.windowId]) await this.keepFocusInSpace(fresh.windowId, [fresh.id]);
      await this.addToSpace([tab.id], tab.windowId, owner, { top: true });
    }
  }

  matchByUrls(tabs, spaces) {
    let best = null;
    let bestScore = 0;
    for (const s of spaces) {
      const urls = new Set((this.l.spaceUrls[s.id] || []).map(normalizeUrl));
      const score = tabs.filter((t) => urls.has(normalizeUrl(t.url))).length;
      if (score > bestScore) [best, bestScore] = [s.id, score];
    }
    return best;
  }

  // Bring the window back in line with the model. Idempotent; runs before
  // every snapshot and after anything that might have broken an invariant.
  async reconcile(windowId) {
    if (!(await this.isManaged(windowId))) return;
    const tree = await this.tree();
    const spaceIds = new Set(tree.spaces.map((s) => s.id));
    const groups = await chrome.tabGroups.query({ windowId });
    const tabs = await chrome.tabs.query({ windowId });
    const active = await this.activeSpaceFor(windowId);
    const prim = (this.s.primary[windowId] ||= {});
    for (const [sid, gid] of Object.entries(prim)) {
      if (!spaceIds.has(sid) || !groups.some((g) => g.id === gid)) delete prim[sid];
    }

    for (const g of groups) {
      let sid = this.s.groupSpace[g.id];
      if (!spaceIds.has(sid)) {
        // Unknown group: after a restart (match by title, then by URLs), or
        // one made in Chrome's tab strip (it joins the active space).
        sid = tree.spaces.find((s) => s.title === g.title)?.id
          || this.matchByUrls(tabs.filter((t) => t.groupId === g.id), tree.spaces)
          || active;
        this.s.groupSpace[g.id] = sid;
      }
      if (prim[sid] == null) prim[sid] = g.id;
      if (prim[sid] === g.id) {
        const space = tree.spaces.find((s) => s.id === sid);
        if (g.title !== space.title || g.color !== space.color) {
          await chrome.tabGroups.update(g.id, { title: space.title, color: space.color }).catch(() => {});
        }
      }
    }

    for (const t of tabs) {
      const bid = this.s.bindings[t.id];
      if (!bid) continue;
      const bm = tree.bookmarks.get(bid);
      const ok = bm?.node.url && (bm.owner === 'fav' ? t.pinned : !t.pinned && this.s.groupSpace[t.groupId] === bm.owner);
      if (!ok) {
        delete this.s.bindings[t.id];
        delete this.s.landing[t.id];
      }
    }

    const loose = tabs.filter((t) => !t.pinned && t.groupId === NONE).map((t) => t.id);
    if (loose.length) await this.addToSpace(loose, windowId, active, { top: false });
  }

  // After a restart tab ids change, so re-bind pinned bookmarks to tabs by URL.
  async rebind(windowId) {
    await this.reconcile(windowId);
    const tree = await this.tree();
    const tabs = await chrome.tabs.query({ windowId });
    const bound = new Set(Object.values(this.s.bindings));
    for (const [bid, { node, owner }] of tree.bookmarks) {
      if (!node.url || bound.has(bid)) continue;
      const last = this.l.lastBound[bid];
      const tab = tabs.find((t) => !this.s.bindings[t.id] && !isNewTabUrl(urlOf(t))
        && (owner === 'fav' ? t.pinned : this.spaceOfTab(t) === owner)
        && ((last && normalizeUrl(t.url) === normalizeUrl(last)) || !isAway(t.url, node.url)));
      if (tab) {
        this.bind(tab.id, bid);
        bound.add(bid);
      }
    }
  }

  async rebindAll() {
    for (const w of await this.managedWindowIds()) await this.rebind(w);
  }

  async persistRecovery() {
    const tree = await this.tree();
    const spaceUrls = {};
    const lastBound = {};
    for (const t of await chrome.tabs.query({ windowType: 'normal' })) {
      const sid = this.spaceOfTab(t);
      if (sid && t.url && !isNewTabUrl(t.url)) (spaceUrls[sid] ||= []).length < 60 && spaceUrls[sid].push(t.url);
      const bid = this.s.bindings[t.id];
      if (bid && tree.bookmarks.has(bid)) lastBound[bid] = t.url;
    }
    // Keep remembered URLs for pinned tabs that aren't open right now.
    for (const [bid, url] of Object.entries(this.l.lastBound)) {
      if (!(bid in lastBound) && tree.bookmarks.has(bid)) lastBound[bid] = url;
    }
    Object.assign(this.l, { spaceUrls, lastBound });
    await this.saveLocal('spaceUrls', 'lastBound');
  }

  // --- Archive -----------------------------------------------------------------

  async archiveAdd(entries) {
    const fresh = entries.filter((e) => e.url && !isNewTabUrl(e.url) && !e.url.startsWith('chrome-extension://'));
    if (!fresh.length) return;
    const urls = new Set(fresh.map((e) => e.url));
    this.l.archive = [
      ...fresh.map((e) => ({ id: crypto.randomUUID(), archivedAt: Date.now(), ...e })),
      ...this.l.archive.filter((a) => !urls.has(a.url)),
    ].slice(0, ARCHIVE_LIMIT);
    await this.saveLocal('archive');
  }

  async sweepArchive() {
    const hours = this.l.settings.archiveAfterHours;
    if (!hours) return;
    const cutoff = Date.now() - hours * 3600e3;
    for (const windowId of await this.managedWindowIds()) {
      const tabs = await chrome.tabs.query({ windowId });
      const stale = tabs.filter((t) => !t.active && !t.pinned && !t.audible && !this.s.bindings[t.id]
        && this.spaceOfTab(t) && t.lastAccessed && t.lastAccessed < cutoff);
      if (stale.length) await chrome.tabs.remove(stale.map((t) => t.id));
    }
  }

  // --- Snapshot for the panel --------------------------------------------------

  tabInfo(t, bookmark) {
    if (!t) return null;
    const url = t.url || t.pendingUrl || '';
    return {
      id: t.id,
      title: t.title || url,
      url,
      favIconUrl: t.favIconUrl || '',
      active: t.active,
      audible: !!t.audible,
      muted: !!t.mutedInfo?.muted,
      sleeping: !!(t.discarded || t.frozen),
      loading: t.status === 'loading',
      away: bookmark ? isAway(url, bookmark.url, this.s.landing[t.id]) : false,
    };
  }

  async snapshot(windowId) {
    const tree = await this.tree();
    const tabs = await chrome.tabs.query({ windowId });
    // Bindings to bookmarks deleted a moment ago are dropped by reconcile;
    // ignore them here too.
    const boundTo = (t) => (tree.bookmarks.get(this.s.bindings[t.id])?.node.url ? this.s.bindings[t.id] : null);
    const byBookmark = new Map();
    for (const t of tabs) if (boundTo(t)) byBookmark.set(boundTo(t), t);
    const node = (n) => (n.url
      ? { kind: 'bookmark', id: n.id, title: n.title, url: n.url, tab: this.tabInfo(byBookmark.get(n.id), n) }
      : { kind: 'folder', id: n.id, title: n.title, expanded: !!this.l.expanded[n.id], children: (n.children || []).map(node) });
    const flat = (n) => (n.children || []).flatMap((c) => (c.url ? [c] : flat(c)));
    const favourites = [
      ...flat(tree.fav).map(node),
      ...tabs.filter((t) => t.pinned && !boundTo(t)).map((t) => ({ kind: 'tab', id: `tab-${t.id}`, tab: this.tabInfo(t) })),
    ];
    const spaces = tree.spaces.map((s) => ({
      id: s.id,
      title: s.title,
      name: s.name,
      emoji: s.emoji,
      color: s.color,
      pinned: (s.node.children || []).map(node),
      today: tabs
        .filter((t) => !t.pinned && !boundTo(t) && this.spaceOfTab(t) === s.id)
        .sort((a, b) => a.index - b.index)
        .map((t) => this.tabInfo(t)),
    }));
    return {
      windowId,
      activeSpaceId: await this.activeSpaceFor(windowId),
      activeTabId: tabs.find((t) => t.active)?.id ?? null,
      favouritesId: tree.fav.id,
      favourites,
      spaces,
      settings: this.l.settings,
      archiveCount: this.l.archive.length,
    };
  }

  // --- Chrome events -------------------------------------------------------------

  async onStartup() {
    this.startingUp = true;
    setTimeout(() => { this.startingUp = false; }, 8000);
    // Session restore brings windows back over the first few seconds.
    for (const delay of [500, 2500, 6000]) {
      setTimeout(() => this.enqueue(() => this.rebindAll()), delay);
    }
  }

  async onInstalled() {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    await this.tree();
    await this.rebindAll();
  }

  async onTabCreated(tab) {
    this.tabCache.set(tab.id, tab);
    if (!(await this.isManaged(tab.windowId))) return;
    let t;
    try {
      t = await chrome.tabs.get(tab.id);
    } catch {
      return;
    }
    if (t.pinned) return;
    if (t.groupId === NONE) {
      await this.addToSpace([t.id], t.windowId, await this.activeSpaceFor(t.windowId), { top: !this.startingUp });
    } else if (this.spaceOfTab(t) && this.l.settings.newTabsOnTop && !this.startingUp && !this.s.bindings[t.id]) {
      // Opened from a link in a space tab: Chrome put it next to its opener.
      await this.moveToTopOfGroup([t.id], t.groupId);
    }
  }

  async onTabRemoved(tabId, { windowId, isWindowClosing }) {
    const info = this.tabCache.get(tabId);
    this.tabCache.delete(tabId);
    if (info) this.removed.set(tabId, { ...info, spaceId: this.spaceOfTab(info), removedAt: Date.now() });
    for (const [id, t] of this.removed) if (Date.now() - t.removedAt > 10000) this.removed.delete(id);
    const wasBound = !!this.s.bindings[tabId];
    delete this.s.bindings[tabId];
    delete this.s.landing[tabId];
    for (const m of Object.values(this.s.lastTab)) for (const [k, v] of Object.entries(m)) if (v === tabId) delete m[k];
    if (isWindowClosing || wasBound || !info || info.pinned || !(await this.isManaged(windowId))) return;
    await this.archiveAdd([{ url: urlOf(info), title: info.title, spaceId: this.spaceOfTab(info) }]);
  }

  async onTabUpdated(tabId, change, tab) {
    this.tabCache.set(tabId, tab);
    // Where a freshly opened pinned tab settles (after redirects like gmail ->
    // /mail/u/0/) still counts as the pinned page. Only same-site redirects.
    const bid = this.s.bindings[tabId];
    if (change.status === 'complete' && bid && !this.s.landing[tabId]) {
      const bm = (await this.tree()).bookmarks.get(bid);
      if (bm?.node.url && sameSite(tab.url, bm.node.url)) this.s.landing[tabId] = tab.url;
    }
    // Pinned while still loading: the bookmark got the URL as its name.
    if (change.title && bid) {
      const bm = (await this.tree()).bookmarks.get(bid);
      if (bm && (bm.node.title === bm.node.url || bm.node.title === urlOf(tab))) {
        await chrome.bookmarks.update(bid, { title: change.title });
      }
    }
    if ('pinned' in change || 'groupId' in change) await this.reconcile(tab.windowId);
  }

  async onTabActivated({ tabId, windowId }) {
    if (!(await this.isManaged(windowId))) return;
    const prevId = this.s.activeTab[windowId];
    this.s.activeTab[windowId] = tabId;
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    const sid = this.spaceOfTab(tab);

    // The active tab was closed (Ctrl+W, the page closed itself...) and Chrome
    // picked a neighbour from another space. Stay in the space instead. The
    // activation can arrive before or after the removal, so check both ways.
    if (prevId != null && prevId !== tabId && !tab.pinned) {
      const prev = this.removed.get(prevId) || this.tabCache.get(prevId);
      const prevSpace = prev && (prev.spaceId ?? this.spaceOfTab(prev));
      if (prevSpace && prevSpace !== sid && prevSpace === this.s.activeSpace[windowId]) {
        let closed = this.removed.has(prevId);
        if (!closed) {
          await sleep(80);
          closed = !(await chrome.tabs.get(prevId).then(() => true, () => false));
        }
        if (closed) {
          const own = (await chrome.tabs.query({ windowId })).filter((t) => t.id !== prevId && this.spaceOfTab(t) === prevSpace).sort(byRecent);
          if (own.length) await chrome.tabs.update(own[0].id, { active: true });
          else await this.createTab(windowId, prevSpace);
          return;
        }
      }
    }

    if (sid) {
      (this.s.lastTab[windowId] ||= {})[sid] = tabId;
      if (sid !== this.s.activeSpace[windowId]) {
        const prevActive = this.s.activeSpace[windowId];
        this.s.activeSpace[windowId] = sid;
        if (prevActive) await this.closeBlankTabs(windowId, prevActive);
        await this.collapseOthers(windowId);
      }
    }
  }

  async onWindowCreated(w) {
    this.windowTypes.set(w.id, w.type);
    if (w.type === 'normal' && this.s.activeSpace[this.lastFocusedWindow]) {
      this.s.activeSpace[w.id] ??= this.s.activeSpace[this.lastFocusedWindow];
    }
  }

  async onWindowRemoved(windowId) {
    this.windowTypes.delete(windowId);
    for (const key of ['activeSpace', 'activeTab', 'lastTab', 'primary']) delete this.s[key][windowId];
  }

  async onGroupRemoved(group) {
    delete this.s.groupSpace[group.id];
    for (const prim of Object.values(this.s.primary)) {
      for (const [sid, gid] of Object.entries(prim)) if (gid === group.id) delete prim[sid];
    }
  }

  async onCommand(command, tab) {
    const windowId = tab?.windowId ?? this.lastFocusedWindow;
    if (!(await this.isManaged(windowId))) return;
    const tree = await this.tree();
    const current = await this.activeSpaceFor(windowId);
    const idx = tree.spaces.findIndex((s) => s.id === current);
    if (command === 'next-space' || command === 'previous-space') {
      const next = tree.spaces[idx + (command === 'next-space' ? 1 : -1)];
      if (next) await this.switchSpace(windowId, next.id);
    } else if (command === 'new-tab-in-space') {
      await this.createTab(windowId, current);
    } else if (command === 'pin-current-tab' && tab) {
      if (this.s.bindings[tab.id]) await this.api.unpinBookmark.call(this, { windowId, id: this.s.bindings[tab.id] });
      else await this.api.pinTab.call(this, { tabId: tab.id });
    } else if (command === 'archive-current-tab' && tab) {
      await this.closeTabs(windowId, [tab.id]);
    }
  }

  // --- API for the panel -----------------------------------------------------------

  api = {
    async switchSpace({ windowId, spaceId }) {
      await this.switchSpace(windowId, spaceId);
    },

    async activateTab({ tabId }) {
      const tab = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    },

    async openBookmark({ windowId, id }) {
      const tree = await this.tree();
      const bm = tree.bookmarks.get(id);
      if (!bm?.node.url) return;
      const tabs = await chrome.tabs.query({ windowId });
      const existing = tabs.find((t) => this.s.bindings[t.id] === id);
      if (bm.owner !== 'fav' && bm.owner !== this.s.activeSpace[windowId]) {
        await this.switchSpace(windowId, bm.owner, { focus: false });
      }
      if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        await this.collapseOthers(windowId);
        return;
      }
      // Reuse an untouched new tab in the same space rather than leaving it behind.
      const current = tabs.find((t) => t.active);
      if (bm.owner !== 'fav' && current && !this.s.bindings[current.id] && this.spaceOfTab(current) === bm.owner
        && (isBlank(current) || current.url === 'about:blank')) {
        await chrome.tabs.update(current.id, { url: bm.node.url });
        this.bind(current.id, id, bm.node.url);
        return;
      }
      const tab = await this.createTab(windowId, bm.owner === 'fav' ? null : bm.owner, {
        url: bm.node.url,
        pinned: bm.owner === 'fav',
      });
      this.bind(tab.id, id, bm.node.url);
      await this.collapseOthers(windowId);
    },

    async closeTab({ windowId, tabId }) {
      await this.closeTabs(windowId, [tabId]);
    },

    // Close a pinned bookmark's tab; the bookmark stays.
    async unloadBookmark({ windowId, id }) {
      const tabs = await chrome.tabs.query({ windowId });
      await this.closeTabs(windowId, tabs.filter((t) => this.s.bindings[t.id] === id).map((t) => t.id));
    },

    async resetBookmark({ windowId, id }) {
      const tree = await this.tree();
      const bm = tree.bookmarks.get(id);
      const tab = (await chrome.tabs.query({ windowId })).find((t) => this.s.bindings[t.id] === id);
      if (!bm || !tab) return;
      delete this.s.landing[tab.id];
      await chrome.tabs.update(tab.id, { url: bm.node.url, active: true });
    },

    async setBookmarkToCurrentUrl({ windowId, id }) {
      const tab = (await chrome.tabs.query({ windowId })).find((t) => this.s.bindings[t.id] === id);
      if (!tab) return;
      await chrome.bookmarks.update(id, { url: tab.url });
      this.s.landing[tab.id] = tab.url;
    },

    async newTab({ windowId, url, spaceId }) {
      await this.createTab(windowId, spaceId ?? (await this.activeSpaceFor(windowId)), { url });
    },

    async searchWeb({ windowId, text }) {
      const tab = await this.createTab(windowId, await this.activeSpaceFor(windowId));
      await chrome.search.query({ text, tabId: tab.id });
    },

    // Pin a tab into a folder (a space, a folder in a space, or favourites).
    async pinTab({ tabId, parentId, index }) {
      const tree = await this.tree();
      const tab = await chrome.tabs.get(tabId);
      const target = parentId ?? this.spaceOfTab(tab) ?? (await this.activeSpaceFor(tab.windowId));
      const owner = this.ownerOf(tree, target);
      const url = urlOf(tab);
      if (!owner || !url || isNewTabUrl(url)) return;
      const bm = await chrome.bookmarks.create({ parentId: target, index, title: tab.title || url, url });
      this.treeCache = null;
      await this.placeTab(tab, owner);
      this.bind(tab.id, bm.id, url);
      this.s.landing[tab.id] = url;
      if (owner !== 'fav' && tree.bookmarks.get(target) && !tree.bookmarks.get(target).node.url) {
        this.l.expanded[target] = true;
        await this.saveLocal('expanded');
      }
      return bm.id;
    },

    // Turn a pinned bookmark back into a Today tab (opening it if needed).
    async unpinBookmark({ windowId, id, beforeTabId }) {
      const tree = await this.tree();
      const bm = tree.bookmarks.get(id);
      if (!bm?.node.url) return;
      let tab = (await chrome.tabs.query({ windowId })).find((t) => this.s.bindings[t.id] === id);
      const space = await this.activeSpaceFor(windowId);
      if (!tab) {
        tab = await this.createTab(windowId, space, { url: bm.node.url, active: false });
      } else if (tab.pinned) {
        await chrome.tabs.update(tab.id, { pinned: false });
        await this.addToSpace([tab.id], windowId, space, { top: true });
      }
      delete this.s.bindings[tab.id];
      await chrome.bookmarks.remove(id);
      this.treeCache = null;
      if (beforeTabId !== undefined) await this.api.reorderTab.call(this, { windowId, tabId: tab.id, beforeTabId, spaceId: space });
    },

    async unpinChromeTab({ windowId, tabId, beforeTabId }) {
      const space = await this.activeSpaceFor(windowId);
      await chrome.tabs.update(tabId, { pinned: false });
      await this.addToSpace([tabId], windowId, space, { top: true });
      if (beforeTabId !== undefined) await this.api.reorderTab.call(this, { windowId, tabId, beforeTabId, spaceId: space });
    },

    async moveBookmark({ id, parentId, index }) {
      const tree = await this.tree();
      const bm = tree.bookmarks.get(id);
      const to = this.ownerOf(tree, parentId);
      if (!bm || !to) return;
      if (to === 'fav' && !bm.node.url) return; // no folders in favourites
      await chrome.bookmarks.move(id, { parentId, index });
      this.treeCache = null;
      if (to === bm.owner) return;
      const ids = new Set([id]);
      const walk = (n) => (n.children || []).forEach((c) => { ids.add(c.id); walk(c); });
      walk(bm.node);
      for (const [tid, bid] of Object.entries(this.s.bindings)) {
        if (!ids.has(bid)) continue;
        try {
          await this.placeTab(await chrome.tabs.get(+tid), to);
        } catch {}
      }
    },

    async moveToSpace({ windowId, kind, id, spaceId }) {
      if (kind === 'tab') {
        await this.keepFocusInSpace(windowId, [id]);
        const tab = await chrome.tabs.get(id);
        if (tab.pinned) await chrome.tabs.update(id, { pinned: false });
        await this.addToSpace([id], windowId, spaceId, { top: true });
      } else {
        await this.api.moveBookmark.call(this, { id, parentId: spaceId });
      }
    },

    async reorderTab({ windowId, tabId, beforeTabId, spaceId }) {
      let tab = await chrome.tabs.get(tabId);
      if (this.spaceOfTab(tab) !== spaceId) {
        await this.keepFocusInSpace(windowId, [tabId]);
        await this.addToSpace([tabId], windowId, spaceId, { top: false });
        tab = await chrome.tabs.get(tabId);
      }
      const gid = tab.groupId;
      if (beforeTabId != null) {
        const ref = await chrome.tabs.get(beforeTabId);
        await chrome.tabs.move(tabId, { index: tab.index < ref.index ? ref.index - 1 : ref.index });
      } else {
        const inGroup = await chrome.tabs.query({ groupId: gid });
        await chrome.tabs.move(tabId, { index: Math.max(...inGroup.map((t) => t.index)) });
      }
      const moved = await chrome.tabs.get(tabId);
      if (moved.groupId !== gid) await chrome.tabs.group({ tabIds: [tabId], groupId: gid });
    },

    async renameBookmark({ id, title }) {
      await chrome.bookmarks.update(id, { title });
    },

    async updateBookmark({ id, title, url }) {
      await chrome.bookmarks.update(id, url ? { title, url } : { title });
    },

    async deleteBookmark({ windowId, id }) {
      const tabs = (await chrome.tabs.query({ windowId })).filter((t) => this.s.bindings[t.id] === id);
      await this.closeTabs(windowId, tabs.map((t) => t.id));
      await chrome.bookmarks.remove(id);
    },

    // Deleting a folder keeps its open tabs; they drop into Today.
    async deleteFolder({ id }) {
      await chrome.bookmarks.removeTree(id);
    },

    async createFolder({ windowId, parentId, title = 'New Folder' }) {
      const parent = parentId ?? (await this.activeSpaceFor(windowId));
      const f = await chrome.bookmarks.create({ parentId: parent, title });
      this.l.expanded[f.id] = true;
      await this.saveLocal('expanded');
      return f.id;
    },

    async addLink({ windowId, parentId, index, title, url }) {
      const parent = parentId ?? (await this.activeSpaceFor(windowId));
      const b = await chrome.bookmarks.create({ parentId: parent, index, title: title || url, url });
      return b.id;
    },

    async toggleFolder({ id, expanded }) {
      this.l.expanded[id] = expanded ?? !this.l.expanded[id];
      await this.saveLocal('expanded');
    },

    async createSpace({ windowId, name, emoji, color }) {
      const tree = await this.tree();
      const f = await chrome.bookmarks.create({ parentId: tree.root.id, title: formatSpaceTitle(emoji, name) });
      this.l.spaceMeta[f.id] = { color: color || SPACE_COLORS[tree.spaces.length % SPACE_COLORS.length] };
      await this.saveLocal('spaceMeta');
      this.treeCache = null;
      await this.switchSpace(windowId, f.id);
      return f.id;
    },

    async updateSpace({ id, name, emoji, color }) {
      if (name !== undefined) await chrome.bookmarks.update(id, { title: formatSpaceTitle(emoji, name) });
      if (color) {
        this.l.spaceMeta[id] = { ...this.l.spaceMeta[id], color };
        await this.saveLocal('spaceMeta');
      }
      this.treeCache = null;
      for (const w of await this.managedWindowIds()) await this.reconcile(w);
    },

    async deleteSpace({ windowId, id }) {
      const tree = await this.tree();
      if (tree.spaces.length < 2) return;
      if (this.s.activeSpace[windowId] === id) {
        const i = tree.spaces.findIndex((s) => s.id === id);
        await this.switchSpace(windowId, (tree.spaces[i + 1] || tree.spaces[i - 1]).id);
      }
      const doomed = (await chrome.tabs.query({})).filter((t) => this.spaceOfTab(t) === id).map((t) => t.id);
      if (doomed.length) await chrome.tabs.remove(doomed);
      await chrome.bookmarks.removeTree(id);
      delete this.l.spaceMeta[id];
      await this.saveLocal('spaceMeta');
    },

    async moveSpace({ id, beforeId }) {
      const tree = await this.tree();
      const kids = tree.root.children;
      let index = beforeId ? kids.findIndex((c) => c.id === beforeId) : kids.length;
      if (index < 0) index = kids.length;
      await chrome.bookmarks.move(id, { parentId: tree.root.id, index });
    },

    async clearToday({ windowId, spaceId }) {
      const tabs = await chrome.tabs.query({ windowId });
      const today = tabs.filter((t) => !t.pinned && !this.s.bindings[t.id] && this.spaceOfTab(t) === spaceId);
      await this.closeTabs(windowId, today.map((t) => t.id));
    },

    async toggleMute({ tabId }) {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { muted: !tab.mutedInfo?.muted });
    },

    async duplicateTab({ tabId }) {
      await chrome.tabs.duplicate(tabId);
    },

    async reloadTab({ tabId }) {
      await chrome.tabs.reload(tabId);
    },

    async rootFolderId() {
      return (await this.tree()).root.id;
    },

    async getArchive() {
      return this.l.archive;
    },

    async restoreArchived({ windowId, id }) {
      const entry = this.l.archive.find((a) => a.id === id);
      if (!entry) return;
      this.l.archive = this.l.archive.filter((a) => a.id !== id);
      await this.saveLocal('archive');
      await this.createTab(windowId, await this.activeSpaceFor(windowId), { url: entry.url });
    },

    async removeArchived({ id }) {
      this.l.archive = this.l.archive.filter((a) => a.id !== id);
      await this.saveLocal('archive');
    },

    async clearArchive() {
      this.l.archive = [];
      await this.saveLocal('archive');
    },

    async setSettings(patch) {
      this.l.settings = { ...this.l.settings, ...patch };
      await this.saveLocal('settings');
      if (patch.collapseOtherSpaces) for (const w of await this.managedWindowIds()) await this.collapseOthers(w);
      if (patch.archiveAfterHours !== undefined) await this.sweepArchive();
    },
  };
}

