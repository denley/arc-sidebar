// Port to the service worker: receives snapshots, sends API calls. Reconnects
// if the worker restarts.

let port = null;
let windowId = null;
let nextId = 1;
const pending = new Map();
const listeners = new Set();
const focusListeners = new Set();

function connect() {
  port = chrome.runtime.connect({ name: 'panel' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'snapshot') {
      for (const l of listeners) l(msg.snapshot);
    } else if (msg.type === 'focusSearch') {
      for (const l of focusListeners) l();
    } else if (msg.type === 'result' && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? resolve(msg.value) : reject(new Error(msg.error));
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    for (const { reject } of pending.values()) reject(new Error('disconnected'));
    pending.clear();
    setTimeout(connect, 150);
  });
  port.postMessage({ type: 'hello', windowId });
}

export async function start(id) {
  windowId = id;
  connect();
  // Keep the worker (and our port) alive while the panel is open.
  setInterval(() => port?.postMessage({ type: 'ping' }), 20000);
}

export function onSnapshot(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function onFocusSearch(fn) {
  focusListeners.add(fn);
  return () => focusListeners.delete(fn);
}

export function call(name, args = {}) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error('not connected'));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ type: 'call', id, name, args: { windowId, ...args } });
  }).catch((e) => {
    console.warn(`[arc-sidebar] ${name} failed:`, e.message);
    throw e;
  });
}

// Fire-and-forget variant for UI handlers.
export const act = (name, args) => { call(name, args).catch(() => {}); };
