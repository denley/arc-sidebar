export const cx = (...parts) => parts.filter(Boolean).join(' ');

export function faviconFor(url, size = 32) {
  if (!url || /^(chrome|about|chrome-extension|devtools):/.test(url)) return '';
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', String(size));
  return u.toString();
}

// Live tabs report their own (possibly dynamic, e.g. unread-count) favicon.
export function tabFavicon(tab, size = 32) {
  if (tab?.favIconUrl && /^(https?|data):/.test(tab.favIconUrl)) return tab.favIconUrl;
  return faviconFor(tab?.url, size);
}

export function prettyUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url;
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host.replace(/^www\./, '')}${path}${u.search}`;
  } catch {
    return url || '';
  }
}

export function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

// Walk a space's pinned tree. fn(node, parentId, index).
export function walkPinned(nodes, parentId, fn) {
  nodes.forEach((n, i) => {
    fn(n, parentId, i);
    if (n.kind === 'folder') walkPinned(n.children, n.id, fn);
  });
}

export function containsActive(node) {
  if (node.kind === 'bookmark') return !!node.tab?.active;
  return node.children.some(containsActive);
}

export function findActiveBookmark(node) {
  if (node.kind === 'bookmark') return node.tab?.active ? node : null;
  for (const c of node.children) {
    const hit = findActiveBookmark(c);
    if (hit) return hit;
  }
  return null;
}
