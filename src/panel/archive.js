import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.js';
import { ConfirmDialog, SettingsDialog } from './dialogs.js';
import { Icon } from './icons.js';
import { act, call } from './rpc.js';
import { Favicon } from './rows.js';
import { dayLabel, faviconFor, prettyUrl } from './util.js';

// Arc's archive: tabs closed from a space (by hand or by auto-archive) land
// here, newest first. Click one to bring it back into the current space.
export function ArchiveView({ ui, onBack }) {
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    call('getArchive').then(setItems).catch(() => setItems([]));
  }, [ui.snap.archiveCount]);

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = (items || []).filter((a) => !f || `${a.title} ${a.url}`.toLowerCase().includes(f));
    const out = [];
    for (const a of list) {
      const label = dayLabel(a.archivedAt);
      if (out.at(-1)?.label !== label) out.push({ label, items: [] });
      out.at(-1).items.push(a);
    }
    return out;
  }, [items, filter]);

  const spaceEmoji = Object.fromEntries(ui.snap.spaces.map((s) => [s.id, s.emoji]));
  const hours = ui.snap.settings.archiveAfterHours;

  return html`
    <div class="archive">
      <div class="archive-head">
        <button class="icon-btn" title="Back" onClick=${onBack}><${Icon} name="back" /></button>
        <h2>Archive</h2>
        <span class="count">${items?.length ?? ''}</span>
      </div>
      <input class="archive-filter" placeholder="Filter archived tabs" value=${filter}
        onInput=${(e) => setFilter(e.target.value)} onKeyDown=${(e) => e.key === 'Escape' && (filter ? setFilter('') : onBack())} />
      <div class="archive-list">
        ${items && !items.length && html`
          <div class="empty-note">
            <${Icon} name="archive" size=${28} />
            <p>Closed tabs land here${hours ? `, and so do tabs you haven't looked at in ${hours >= 24 ? `${hours / 24} day${hours > 24 ? 's' : ''}` : `${hours} hours`}` : ''}.</p>
          </div>`}
        ${groups.map((g) => html`
          <div class="section-label">${g.label}</div>
          ${g.items.map((a) => html`
            <div class="row archived" key=${a.id} role="button" tabindex="0" title=${a.url}
              onClick=${() => { act('restoreArchived', { id: a.id }); onBack(); }}
              onKeyDown=${(e) => e.key === 'Enter' && e.currentTarget.click()}>
              <span class="icon-slot"><${Favicon} src=${faviconFor(a.url)} /></span>
              <span class="title archived-text">
                <span class="archived-title">${a.title || prettyUrl(a.url)}</span>
                <span class="archived-sub">${spaceEmoji[a.spaceId] ? `${spaceEmoji[a.spaceId]} ` : ''}${prettyUrl(a.url)}</span>
              </span>
              <button class="row-btn close" title="Remove from archive" tabindex="-1"
                onClick=${(e) => { e.stopPropagation(); act('removeArchived', { id: a.id }); }}>
                <${Icon} name="x" size=${14} />
              </button>
            </div>`)}
        `)}
      </div>
      <div class="archive-foot">
        <button class="link-btn" onClick=${() => ui.openDialog(SettingsDialog, {})}>
          <${Icon} name="clock" /> ${hours ? `Auto-archive after ${hours >= 24 ? `${hours / 24}d` : `${hours}h`}` : 'Auto-archive off'}
        </button>
        ${items?.length > 0 && html`
          <button class="link-btn danger" onClick=${() => ui.openDialog(ConfirmDialog, {
            title: 'Clear the archive?', message: 'This forgets every archived tab.', confirm: 'Clear',
            run: () => act('clearArchive'),
          })}>Clear all</button>`}
      </div>
    </div>`;
}
