import { Engine } from './engine.js';

const engine = new Engine();
const run = (fn) => (...args) => engine.enqueue(() => fn(...args));
const refresh = () => engine.schedulePublish();

// Listeners must be registered synchronously at the top level in MV3.
chrome.runtime.onInstalled.addListener(run(() => engine.onInstalled()));
chrome.runtime.onStartup.addListener(run(() => engine.onStartup()));
chrome.runtime.onConnect.addListener((port) => port.name === 'panel' && engine.onConnect(port));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'focus-search') {
    // sidePanel.open needs the user gesture, so call it before anything async.
    const windowId = tab?.windowId ?? engine.lastFocusedWindow;
    chrome.sidePanel.open({ windowId }).catch(() => {});
    const tell = () => {
      for (const [port, w] of engine.ports) if (w === windowId) try { port.postMessage({ type: 'focusSearch' }); } catch {}
    };
    setTimeout(tell, 150);
    setTimeout(tell, 600); // in case the panel was still starting
    return;
  }
  engine.enqueue(() => engine.onCommand(command, tab));
});

chrome.tabs.onCreated.addListener(run((tab) => engine.onTabCreated(tab)));
chrome.tabs.onRemoved.addListener(run((tabId, info) => engine.onTabRemoved(tabId, info)));
chrome.tabs.onUpdated.addListener(run((tabId, change, tab) => engine.onTabUpdated(tabId, change, tab)));
chrome.tabs.onActivated.addListener(run((info) => engine.onTabActivated(info)));
chrome.tabs.onAttached.addListener(run((tabId, { newWindowId }) => engine.reconcile(newWindowId)));
chrome.tabs.onMoved.addListener(refresh);
chrome.tabs.onDetached.addListener(refresh);
chrome.tabs.onReplaced.addListener(refresh);

chrome.tabGroups.onRemoved.addListener(run((group) => engine.onGroupRemoved(group)));
chrome.tabGroups.onUpdated.addListener(refresh);
chrome.tabGroups.onCreated.addListener(refresh);

chrome.windows.onCreated.addListener(run((w) => engine.onWindowCreated(w)));
chrome.windows.onRemoved.addListener(run((id) => engine.onWindowRemoved(id)));
chrome.windows.onFocusChanged.addListener((id) => {
  if (id !== chrome.windows.WINDOW_ID_NONE) engine.lastFocusedWindow = id;
});

const bookmarksChanged = () => {
  engine.treeCache = null;
  refresh();
};
for (const event of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  chrome.bookmarks[event].addListener(bookmarksChanged);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refresh();
});

chrome.alarms.onAlarm.addListener(run((alarm) => {
  if (alarm.name === 'archive') return engine.sweepArchive();
  if (alarm.name === 'persist') return engine.persistRecovery();
}));
chrome.alarms.get('archive').then((a) => a || chrome.alarms.create('archive', { periodInMinutes: 10 }));
chrome.alarms.get('persist').then((a) => a || chrome.alarms.create('persist', { periodInMinutes: 1 }));

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// For tools/test.mjs.
self.engine = engine;
