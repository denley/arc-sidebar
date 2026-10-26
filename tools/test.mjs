// Behaviour tests for the engine against a real headless Chromium.
//   node tools/test.mjs

import { boot } from './dev.mjs';
import { sleep } from './cdp.mjs';

const env = await boot();
const { sw, mainWindow: W, settle } = env;
let failures = 0;
let passes = 0;

const ev = (code) => sw.evaluate(`(async () => { ${code} })()`);
const api = async (name, args = {}) => {
  const r = await ev(`return engine.call('${name}', ${JSON.stringify({ windowId: W, ...args })})`);
  await settle(150);
  return r;
};
const snap = () => ev(`await engine.chain; return engine.snapshot(${W})`);
const tabs = () => ev(`return (await chrome.tabs.query({ windowId: ${W} })).map(t => ({ id: t.id, url: t.url || t.pendingUrl, active: t.active, pinned: t.pinned, groupId: t.groupId, index: t.index }))`);
const groups = () => ev(`return (await chrome.tabGroups.query({ windowId: ${W} })).map(g => ({ id: g.id, title: g.title, collapsed: g.collapsed, color: g.color }))`);

function check(name, cond, detail) {
  if (cond) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail, null, 1) : '');
  }
}

const space = (s, title) => s.spaces.find((x) => x.title.endsWith(title));
const findPinned = (s, title) => {
  let hit = null;
  const walk = (nodes) => nodes.forEach((n) => { if (n.title === title) hit = n; if (n.children) walk(n.children); });
  for (const sp of s.spaces) walk(sp.pinned);
  return hit || s.favourites.find((f) => f.title === title);
};

try {
  console.log('setup');
  await ev(`for (const url of ['https://example.com/', 'https://example.org/']) await chrome.tabs.create({ windowId: ${W}, url, active: false });`);
  await settle(800);
  let s = await snap();
  const personal = space(s, 'Personal');
  const home = space(s, 'Home');
  check('seeded two spaces and six favourites', s.spaces.length === 2 && s.favourites.length === 6, s.spaces.map((x) => x.title));
  check('loose tabs joined the active space', (await tabs()).every((t) => t.pinned || t.groupId !== -1));
  check('no blank tab got bound to a pinned bookmark', !findPinned(s, 'Notion').tab);

  console.log('open a pinned bookmark');
  await api('openBookmark', { id: findPinned(s, 'Google Maps').id });
  s = await snap();
  let maps = findPinned(s, 'Google Maps');
  check('bookmark is bound to an active tab', maps.tab?.active, maps);
  check('bound tab is not listed in Today', !space(s, 'Personal').today.some((t) => t.id === maps.tab?.id));
  const count = (await tabs()).length;
  await api('openBookmark', { id: maps.id });
  check('opening again reuses the tab', (await tabs()).length === count && findPinned(await snap(), 'Google Maps').tab?.id === maps.tab.id);

  console.log('switch space');
  await api('switchSpace', { spaceId: home.id });
  s = await snap();
  let g = await groups();
  check('active space is Home', s.activeSpaceId === home.id);
  check('Home got a blank tab', space(s, 'Home').today.length === 1, space(s, 'Home').today);
  check('Personal group collapsed', g.find((x) => x.title === personal.title)?.collapsed === true, g);
  await api('switchSpace', { spaceId: personal.id });
  s = await snap();
  check('switching back returns to Google Maps', findPinned(s, 'Google Maps').tab?.active);
  check('Home blank tab was cleaned up', space(s, 'Home').today.length === 0, space(s, 'Home').today);

  console.log('favourites');
  const claude = s.favourites.find((f) => f.title === 'Claude');
  await api('openBookmark', { id: claude.id });
  s = await snap();
  const claudeTab = (await tabs()).find((t) => t.url?.includes('claude.ai'));
  check('favourite opens as a Chrome-pinned tab', claudeTab?.pinned, claudeTab);
  check('favourite tile shows it open', s.favourites.find((f) => f.id === claude.id).tab?.active);
  check('space unchanged', s.activeSpaceId === personal.id);

  console.log('pin and unpin a Today tab');
  s = await snap();
  const example = space(s, 'Personal').today.find((t) => t.url.includes('example.com'));
  const bmId = await api('pinTab', { tabId: example.id });
  s = await snap();
  let node = findPinned(s, example.title);
  check('pinning creates a bound bookmark', node?.id === bmId && node.tab?.id === example.id, node);
  check('tab left Today', !space(s, 'Personal').today.some((t) => t.id === example.id));
  await api('unpinBookmark', { id: bmId });
  s = await snap();
  check('unpinning puts it back in Today', space(s, 'Personal').today.some((t) => t.id === example.id));
  check('and removes the bookmark', !findPinned(s, example.title));

  console.log('drag a pinned bookmark into favourites while open');
  maps = findPinned(s, 'Google Maps');
  await api('moveBookmark', { id: maps.id, parentId: s.favouritesId, index: 0 });
  s = await snap();
  const mapsFav = s.favourites.find((f) => f.id === maps.id);
  check('bookmark is a favourite and still bound', mapsFav?.tab?.id === maps.tab.id, mapsFav);
  check('its tab is now Chrome-pinned', (await tabs()).find((t) => t.id === maps.tab.id)?.pinned);
  await api('moveBookmark', { id: maps.id, parentId: personal.id, index: 0 });
  s = await snap();
  maps = findPinned(s, 'Google Maps');
  check('moved back into the space, tab unpinned and bound', maps.tab && !(await tabs()).find((t) => t.id === maps.tab.id)?.pinned, maps);

  console.log('reorder bookmarks in the same folder');
  s = await snap();
  const order = () => space(s, 'Personal').pinned.map((n) => n.title);
  const before = order();
  const first = space(s, 'Personal').pinned[0];
  await api('moveBookmark', { id: first.id, parentId: personal.id, index: 3 });
  s = await snap();
  check('moving item 0 to slot 3 lands it third', order()[2] === first.title, { before, after: order() });

  console.log('new tabs go to the top of Today');
  await ev(`await chrome.tabs.create({ windowId: ${W}, url: 'https://example.net/', active: true })`);
  await settle(500);
  s = await snap();
  check('new tab is first in Today', space(s, 'Personal').today[0]?.url.includes('example.net'), space(s, 'Personal').today.map((t) => t.url));

  console.log('reorder Today');
  let today = space(s, 'Personal').today;
  await api('reorderTab', { tabId: today[0].id, beforeTabId: null, spaceId: personal.id });
  s = await snap();
  today = space(s, 'Personal').today;
  check('moved to the end', today.at(-1).url.includes('example.net'), today.map((t) => t.url));

  console.log('closing keeps focus in the space and archives');
  await ev(`await chrome.tabs.update(${today.at(-1).id}, { active: true })`);
  await settle(300);
  const archiveBefore = (await snap()).archiveCount;
  await api('closeTab', { tabId: today.at(-1).id });
  s = await snap();
  const activeTab = (await tabs()).find((t) => t.active);
  check('focus stayed in Personal', s.activeSpaceId === personal.id && (activeTab.pinned === false), activeTab);
  check('closed tab archived', s.archiveCount === archiveBefore + 1, s.archiveCount);

  console.log('Ctrl+W on the last tab of a space with a neighbouring space');
  await api('switchSpace', { spaceId: home.id });
  await api('openBookmark', { id: findPinned(await snap(), 'AirTouch').id });
  s = await snap();
  const air = findPinned(s, 'AirTouch').tab;
  const homeBlank = space(s, 'Home').today.map((t) => t.id);
  await ev(`await chrome.tabs.remove(${JSON.stringify(homeBlank)})`);
  await settle(300);
  await ev(`await chrome.tabs.remove(${air.id})`);
  await settle(800);
  s = await snap();
  check('still in Home after closing its last tab', s.activeSpaceId === home.id, s.activeSpaceId);

  console.log('a group made in Chrome is adopted by the active space');
  const t1 = await ev(`return (await chrome.tabs.create({ windowId: ${W}, url: 'https://example.com/?x', active: false })).id`);
  await settle(300);
  await ev(`const g = await chrome.tabs.group({ tabIds: [${t1}], createProperties: { windowId: ${W} } }); await chrome.tabGroups.update(g, { title: 'mine' })`);
  await settle(500);
  s = await snap();
  check('tab still shows in the active space', space(s, 'Home').today.some((t) => t.id === t1), space(s, 'Home').today);

  console.log('restart recovery');
  await ev(`await engine.enqueue(() => engine.persistRecovery())`);
  await ev(`engine.s.groupSpace = {}; engine.s.primary = {}; engine.s.bindings = {}; engine.s.activeSpace = {};`);
  await ev(`await engine.enqueue(() => engine.rebindAll())`);
  await settle(300);
  s = await snap();
  check('Personal tabs recovered', space(s, 'Personal').today.length >= 1, space(s, 'Personal').today);
  check('Google Maps rebound', !!findPinned(s, 'Google Maps').tab);
  check('Claude favourite rebound', !!s.favourites.find((f) => f.title === 'Claude')?.tab);

  console.log('restart while a favourite tab is still loading');
  await api('openBookmark', { id: s.favourites.find((f) => f.title === 'Gmail').id });
  s = await snap();
  const claudeId = s.favourites.find((f) => f.title === 'Claude').tab.id;
  const gmailId = s.favourites.find((f) => f.title === 'Gmail').tab.id;
  await ev(`await chrome.tabs.move(${gmailId}, { index: 0 })`); // ahead of Claude's tab
  await ev(`await engine.enqueue(() => engine.persistRecovery())`);
  // Session restore: the tab knows where it's going (pendingUrl) but url is still empty.
  await ev(`engine.s.bindings = {};
    self.realQuery = chrome.tabs.query;
    chrome.tabs.query = async (...a) => (await realQuery.apply(chrome.tabs, a))
      .map((t) => (t.id === ${gmailId} ? { ...t, url: '', pendingUrl: 'https://mail.google.com/' } : t));`);
  await ev(`await engine.enqueue(() => engine.rebindAll())`);
  await ev(`chrome.tabs.query = realQuery`);
  s = await snap();
  check('Claude keeps its own tab', s.favourites.find((f) => f.title === 'Claude').tab?.id === claudeId, s.favourites);
  check('Gmail gets the loading tab', s.favourites.find((f) => f.title === 'Gmail').tab?.id === gmailId, s.favourites);

  console.log('spaces');
  const newId = await api('createSpace', { name: 'Work', emoji: '💼', color: 'blue' });
  s = await snap();
  check('created and switched to the new space', s.activeSpaceId === newId);
  await api('newTab', { spaceId: newId, url: 'https://example.com/?work' });
  await api('updateSpace', { id: newId, name: 'Job', emoji: '🧪', color: 'red' });
  s = await snap();
  g = await groups();
  check('renamed space retitles its group', g.some((x) => x.title === '🧪 Job' && x.color === 'red'), g);
  await api('moveSpace', { id: newId, beforeId: personal.id });
  s = await snap();
  check('moved to first', s.spaces[0].id === newId, s.spaces.map((x) => x.title));
  await api('deleteSpace', { id: newId });
  s = await snap();
  check('deleted and moved to a neighbour', !s.spaces.some((x) => x.id === newId) && s.spaces.some((x) => x.id === s.activeSpaceId));

  console.log('folders');
  const folderId = await api('createFolder', { parentId: personal.id, title: 'Stuff' });
  await api('switchSpace', { spaceId: personal.id });
  s = await snap();
  const exampleOrg = space(s, 'Personal').today.find((t) => t.url.includes('example.org'));
  await api('pinTab', { tabId: exampleOrg.id, parentId: folderId });
  s = await snap();
  const folder = space(s, 'Personal').pinned.find((n) => n.id === folderId);
  check('tab pinned into folder', folder?.children[0]?.tab?.id === exampleOrg.id, folder);
  await api('deleteFolder', { id: folderId });
  s = await snap();
  check('deleting the folder keeps its tab in Today', space(s, 'Personal').today.some((t) => t.id === exampleOrg.id));

  console.log('auto-archive');
  await ev(`engine.l.settings.archiveAfterHours = 0.0001`);
  await sleep(600);
  const n = (await snap()).archiveCount;
  await ev(`await engine.enqueue(() => engine.sweepArchive())`);
  await settle(300);
  s = await snap();
  check('stale background tabs were archived', s.archiveCount > n, { before: n, after: s.archiveCount });
  check('active tab survived', (await tabs()).some((t) => t.active));
} catch (e) {
  failures++;
  console.error(e);
} finally {
  console.log(`\n${passes} passed, ${failures} failed`);
  await Promise.race([env.close(), sleep(3000)]);
  process.exit(failures ? 1 : 0);
}
