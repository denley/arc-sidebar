import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { SPACE_COLORS, toUrl } from '../shared/common.js';
import { Icon } from './icons.js';
import { act, call } from './rpc.js';
import { swatch } from './theme.js';
import { cx } from './util.js';

export function DialogShell({ title, onClose, onSubmit, children, actions }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current?.querySelector('[autofocus], input, button.primary');
    el?.focus();
    el?.select?.();
  }, []);
  return html`
    <div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
      <form class="dialog" ref=${ref} role="dialog" aria-label=${title}
        onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
        onSubmit=${(e) => { e.preventDefault(); onSubmit?.(); }}>
        <h2>${title}</h2>
        ${children}
        <div class="dialog-actions">${actions}</div>
      </form>
    </div>`;
}

export function ConfirmDialog({ title, message, confirm = 'OK', run, onClose }) {
  return html`
    <${DialogShell} title=${title} onClose=${onClose} onSubmit=${() => { run(); onClose(); }}
      actions=${html`
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button type="submit" class="btn primary danger">${confirm}</button>`}>
      <p class="dialog-text">${message}</p>
    <//>`;
}

export function BookmarkDialog({ node, parentId, onClose }) {
  const [title, setTitle] = useState(node?.title || '');
  const [url, setUrl] = useState(node?.url || '');
  const resolved = toUrl(url) || (url.includes(':') ? url : null);
  const save = () => {
    if (!resolved) return;
    if (node) act('updateBookmark', { id: node.id, title: title.trim() || resolved, url: resolved });
    else act('addLink', { parentId, title: title.trim(), url: resolved });
    onClose();
  };
  return html`
    <${DialogShell} title=${node ? 'Edit pinned tab' : 'Pin a link'} onClose=${onClose} onSubmit=${save}
      actions=${html`
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button type="submit" class="btn primary" disabled=${!resolved}>Save</button>`}>
      <label class="field"><span>Name</span>
        <input value=${title} onInput=${(e) => setTitle(e.target.value)} placeholder="Name" autofocus=${!!node} />
      </label>
      <label class="field"><span>URL</span>
        <input value=${url} onInput=${(e) => setUrl(e.target.value)} placeholder="example.com" spellcheck="false" autofocus=${!node} />
      </label>
    <//>`;
}

const EMOJI = [
  '🏠', '💼', '🌿', '🎨', '🎮', '🎵', '📚', '🧪', '💻', '🛠️', '🚀', '✈️',
  '🍳', '💰', '❤️', '⭐', '🔥', '🌙', '☀️', '🌊', '🐱', '🐶', '🌸', '🍀',
  '📷', '🎬', '🧘', '🏃', '⚽', '🎓', '🧠', '📝', '📈', '🛒', '🏡', '👶',
];

export function SpaceDialog({ space, onClose }) {
  const [name, setName] = useState(space?.name || '');
  const [emoji, setEmoji] = useState(space ? space.emoji : '');
  const [color, setColor] = useState(space?.color || SPACE_COLORS[0]);
  const [custom, setCustom] = useState('');
  const save = () => {
    const n = name.trim() || 'Untitled';
    if (space) act('updateSpace', { id: space.id, name: n, emoji, color });
    else act('createSpace', { name: n, emoji, color });
    onClose();
  };
  return html`
    <${DialogShell} title=${space ? 'Edit space' : 'New space'} onClose=${onClose} onSubmit=${save}
      actions=${html`
        <button type="button" class="btn" onClick=${onClose}>Cancel</button>
        <button type="submit" class="btn primary">${space ? 'Save' : 'Create space'}</button>`}>
      <div class="space-preview" style=${`--swatch:${swatch(color)}`}>
        <span class="space-preview-icon">${emoji || html`<span class="dot" />`}</span>
        <input class="space-preview-name" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="Space name" autofocus />
      </div>
      <div class="field"><span>Colour</span>
        <div class="swatches">
          ${SPACE_COLORS.map((c) => html`
            <button type="button" class=${cx('swatch', c === color && 'selected')} style=${`--swatch:${swatch(c)}`}
              title=${c} aria-label=${c} onClick=${() => setColor(c)} />`)}
        </div>
      </div>
      <div class="field"><span>Icon</span>
        <div class="emoji-grid">
          <button type="button" class=${cx('emoji', !emoji && 'selected')} title="No icon" onClick=${() => setEmoji('')}>
            <span class="dot" style=${`--swatch:${swatch(color)}`} />
          </button>
          ${EMOJI.map((e) => html`
            <button type="button" class=${cx('emoji', e === emoji && 'selected')} onClick=${() => setEmoji(e)}>${e}</button>`)}
        </div>
        <input class="emoji-custom" value=${custom} placeholder="…or type/paste any emoji"
          onInput=${(e) => {
            setCustom(e.target.value);
            const first = [...new Intl.Segmenter().segment(e.target.value.trim())][0]?.segment;
            if (first) setEmoji(first);
          }} />
      </div>
    <//>`;
}

const ARCHIVE_CHOICES = [[0, 'Never'], [12, 'After 12 hours'], [24, 'After a day'], [168, 'After a week'], [720, 'After 30 days']];

export function SettingsDialog({ onClose, settings }) {
  const set = (patch) => act('setSettings', patch);
  const open = (url) => { chrome.tabs.create({ url }); onClose(); };
  return html`
    <${DialogShell} title="Settings" onClose=${onClose}
      actions=${html`<button type="button" class="btn primary" onClick=${onClose}>Done</button>`}>
      <label class="field"><span>Archive Today tabs I haven't opened</span>
        <select value=${settings.archiveAfterHours} onChange=${(e) => set({ archiveAfterHours: Number(e.target.value) })}>
          ${ARCHIVE_CHOICES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
        </select>
      </label>
      <label class="check">
        <input type="checkbox" checked=${settings.newTabsOnTop} onChange=${(e) => set({ newTabsOnTop: e.target.checked })} />
        <span>New tabs go to the top of Today</span>
      </label>
      <label class="check">
        <input type="checkbox" checked=${settings.collapseOtherSpaces} onChange=${(e) => set({ collapseOtherSpaces: e.target.checked })} />
        <span>Collapse other spaces in Chrome's tab strip</span>
      </label>
      <div class="dialog-links">
        <button type="button" class="link-btn" onClick=${() => open('chrome://extensions/shortcuts')}>
          <${Icon} name="keyboard" /> Keyboard shortcuts
        </button>
        <button type="button" class="link-btn" onClick=${async () => open(`chrome://bookmarks/?id=${await call('rootFolderId')}`)}>
          <${Icon} name="bookmark" /> Edit in bookmark manager
        </button>
      </div>
    <//>`;
}
