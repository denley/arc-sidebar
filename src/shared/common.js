// Shared between the service worker and the side panel.

export const ROOT_TITLE = 'Arc Sidebar';
export const FAVOURITES_TITLE = 'Favourites';

// Space colours. Each maps to a Chrome tab group colour and to a named colour
// in the Omarchy theme palette (see src/panel/theme.js).
export const SPACE_COLORS = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'cyan', 'grey'];

export const DEFAULT_SETTINGS = {
  // Close and archive Today tabs that haven't been looked at for this long.
  // 0 disables auto-archiving.
  archiveAfterHours: 12,
  // Collapse other spaces' tab groups in Chrome's own tab strip.
  collapseOtherSpaces: true,
  // Put new tabs at the top of Today, like Arc.
  newTabsOnTop: true,
};

export const ARCHIVE_LIMIT = 500;

const EMOJI_PREFIX = /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|⃣|\p{Emoji_Modifier}|‍(?:\p{Extended_Pictographic}|\p{Emoji_Component})|\p{Regional_Indicator})*)\s*/u;

// "🏠 Home" -> { emoji: '🏠', name: 'Home' }
export function parseSpaceTitle(title) {
  const m = title.match(EMOJI_PREFIX);
  if (!m) return { emoji: '', name: title.trim() || 'Untitled' };
  return { emoji: m[1], name: title.slice(m[0].length).trim() || 'Untitled' };
}

export function formatSpaceTitle(emoji, name) {
  return [emoji, name.trim()].filter(Boolean).join(' ');
}

const NEW_TAB_URLS = ['chrome://newtab/', 'chrome://new-tab-page/', 'about:blank', 'chrome://newtab', 'chrome://new-tab-page'];
export const isNewTabUrl = (url) => !url || NEW_TAB_URLS.includes(url);

// Comparable form of a URL: no hash, no trailing slash, lower-case host.
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    let s = `${u.protocol}//${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname}${u.search}`;
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return url || '';
  }
}

// Has a tab bound to a pinned bookmark wandered off the pinned page? Staying
// under the pinned path (or on the page the pinned URL redirected to on first
// load) still counts as home.
export function isAway(tabUrl, bookmarkUrl, landingUrl) {
  if (!tabUrl || isNewTabUrl(tabUrl)) return false;
  const t = normalizeUrl(tabUrl);
  const b = normalizeUrl(bookmarkUrl);
  if (t === b || t.startsWith(`${b}/`) || (b.includes('?') && t.startsWith(b))) return false;
  if (landingUrl && t === normalizeUrl(landingUrl)) return false;
  return true;
}

export function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Turns what the user typed into a URL if it looks like one.
export function toUrl(text) {
  const s = text.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|chrome|data|file|view-source):/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(s)) return `http://${s}`;
  if (/^[^/:]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return `https://${s}`;
  return null;
}

// Same registrable-ish domain: mail.google.com ~ accounts.google.com,
// but bbc.co.uk !~ gov.co.uk.
export function sameSite(a, b) {
  const site = (url) => {
    try {
      const parts = new URL(url).hostname.split('.');
      const n = parts.length > 2 && parts.at(-1).length === 2 && parts.at(-2).length <= 3 ? 3 : 2;
      return parts.slice(-n).join('.');
    } catch {
      return null;
    }
  };
  const x = site(a);
  return !!x && x === site(b);
}
