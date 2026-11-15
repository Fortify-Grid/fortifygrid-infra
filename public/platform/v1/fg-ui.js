/* FortifyGrid shared UI, v1: plain JS, no build, no dependencies. Gives window.FG. Rules: platform/UI_PRINCIPLES.md.
   Load: <script src="https://fortifygrid.com/platform/v1/fg-ui.js"></script> (classic script; works in any page).
   v1 changes stay backward compatible; a breaking change becomes v2. Demo: /platform/v1/demo.html */
(() => {
  const FG = (window.FG = window.FG || {});
  FG.version = '1.0.0';

  // Every app, for the Apps menu. Home lists only the apps you can open; this list is the same for everyone.
  FG.HOME = { name: '⌂ Home: all apps', url: 'https://app.fortifygrid.com/' };
  FG.APPS = [
    { id: 'website', name: 'Website', url: 'https://fortifygrid.com/' },
    { id: 'workplan', name: 'Planner', url: 'https://app.fortifygrid.com/workplan/' },
    { id: 'ide', name: 'IDE', url: 'https://app.fortifygrid.com/ide/' },
    { id: 'heatmap', name: 'Grid heatmap (RAG)', url: 'https://heatmap.fortifygrid.com/' },
    { id: 'query', name: 'Market query (RAG)', url: 'https://query.fortifygrid.com/' },
    { id: 'revenue', name: 'Revenue analysis', url: 'https://rev-anal.fortifygrid.com/' },
  ];

  /* ---------- basics ---------- */
  const cfg = (FG.config = { app: 'app', user: '' });
  FG.configure = (o) => Object.assign(cfg, o);
  FG.store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  // One person's setting in one app, in this browser: fg:<app>:<email>:<name>
  FG.key = (name) => `fg:${cfg.app}:${cfg.user || 'anon'}:${name}`;
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (FG.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]));
  // Saved order first (ids still present), then new items in their default order.
  FG.orderBy = (items, order = [], idOf = (x) => x) => {
    const known = (order || []).filter((k) => items.some((x) => String(idOf(x)) === String(k)));
    return [...known.map((k) => items.find((x) => String(idOf(x)) === String(k))), ...items.filter((x) => !known.map(String).includes(String(idOf(x))))];
  };
  // Drop `moving` on `target`: it takes the target's place.
  const moveKey = (FG.moveKey = (keys, moving, target) => {
    const ks = keys.map(String); moving = String(moving); target = String(target);
    if (moving === target || !ks.includes(moving) || !ks.includes(target)) return ks;
    const rest = ks.filter((k) => k !== moving); rest.splice(rest.indexOf(target), 0, moving); return rest;
  });
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

  // ⓘ help: FG.info(text) → HTML. One listener opens / closes every one on the page.
  FG.info = (text, right) => `<span class="fg-info${right ? ' right' : ''}"><button type="button" aria-label="What is this?">i</button><span role="tooltip" hidden>${esc(text)}</span></span>`;
  document.addEventListener('click', (e) => {
    const box = e.target.closest?.('.fg-info');
    document.querySelectorAll('.fg-info.open').forEach((b) => { if (b !== box) { b.classList.remove('open'); b.querySelector('[role=tooltip]').hidden = true; } });
    if (box && e.target.closest('button')) { e.preventDefault(); e.stopPropagation(); const tip = box.querySelector('[role=tooltip]'); tip.hidden = !tip.hidden; box.classList.toggle('open', !tip.hidden); }
  }, true);

  // Drag to reorder the items (sel, each with data-id) inside box. ids() = current order; done(newOrder).
  // handle: a selector inside each item; then only a drag that starts on the handle moves the item.
  FG.sortable = (box, sel, ids, done, handle) => {
    let from = null;
    const clear = () => { from = null; box.querySelectorAll('.over, .dragging').forEach((x) => x.classList.remove('over', 'dragging')); };
    if (handle) {
      box.addEventListener('pointerdown', (e) => { const h = e.target.closest?.(handle); const it = h?.closest(sel); if (it) it.draggable = true; });
      box.addEventListener('pointerup', () => box.querySelectorAll(`${sel}[draggable="true"]`).forEach((x) => { x.draggable = false; }));
    }
    box.addEventListener('dragstart', (e) => {
      const it = e.target.closest?.(sel); if (!it || !box.contains(it)) return;
      from = it.dataset.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', from); it.classList.add('dragging');
    });
    box.addEventListener('dragover', (e) => {
      const it = e.target.closest?.(sel); if (from == null || !it || !box.contains(it)) return;
      e.preventDefault(); box.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); if (it.dataset.id !== from) it.classList.add('over');
    });
    box.addEventListener('drop', (e) => {
      const it = e.target.closest?.(sel); if (from == null) return; e.preventDefault();
      if (it && box.contains(it) && it.dataset.id !== from) done(moveKey(ids(), from, it.dataset.id));
      clear();
    });
    box.addEventListener('dragend', () => { clear(); if (handle) box.querySelectorAll(`${sel}[draggable="true"]`).forEach((x) => { x.draggable = false; }); });
  };

  /* ---------- shell: sidebar with brand · Apps · sections · channels · you ----------
     FG.shell(asideEl, { app, name, icon, home, sections: [{id, label, href?, locked?}], current, onSection(id),
       channelsTitle, channels: [{id, label, badge?}], channel, onChannel(id), user, signOut })
     → { update(partialOpts) }. Sections and channels can be dragged; order saved per browser. */
  FG.shell = (side, o) => {
    side.classList.add('fg-side');
    let menu = false;
    const draw = () => {
      const secs = FG.orderBy(o.sections || [], FG.store.get(FG.key('nav:sections')), (s) => s.id);
      const chans = FG.orderBy(o.channels || [], FG.store.get(FG.key('nav:channels')), (c) => c.id);
      const item = (x, on, kind) => (x.locked
        ? `<span class="fg-nav-item locked" data-id="${esc(x.id)}" draggable="true" title="Your role does not include this — ask an admin">${esc(x.label)}</span>`
        : x.href
          ? `<a class="fg-nav-item${on ? ' on' : ''}" data-id="${esc(x.id)}" data-kind="${kind}" href="${esc(x.href)}" draggable="true"${on ? ' aria-current="page"' : ''}>${esc(x.label)}${x.badge ? `<span class="fg-badge">${esc(x.badge)}</span>` : ''}</a>`
          : `<button type="button" class="fg-nav-item${on ? ' on' : ''}" data-id="${esc(x.id)}" data-kind="${kind}" draggable="true"${on ? ' aria-current="page"' : ''}>${esc(x.label)}${x.badge ? `<span class="fg-badge">${esc(x.badge)}</span>` : ''}</button>`);
      side.innerHTML = `
        <a class="fg-brand" href="${esc(o.home || '/')}" title="${esc(o.name)}: home">${o.icon ? `<img src="${esc(o.icon)}" alt="">` : ''}${esc(o.name)}</a>
        <div class="fg-apps"><button type="button" class="fg-apps-btn" aria-haspopup="menu" aria-expanded="${menu}">Apps ▾</button>
          ${menu ? `<div class="fg-apps-menu" role="menu"><a role="menuitem" href="${FG.HOME.url}">${esc(FG.HOME.name)}</a><hr>${FG.APPS.map((a) =>
            `<a role="menuitem" href="${a.url}"${a.id === o.app ? ' class="on" aria-current="page"' : ''}>${esc(a.name)}</a>`).join('')}</div>` : ''}</div>
        ${secs.length ? `<nav class="fg-nav sections" aria-label="Sections">${secs.map((s) => item(s, s.id === o.current, 'section')).join('')}</nav>` : ''}
        ${chans.length ? `<div class="fg-side-h">${esc(o.channelsTitle || 'Channels')}</div><nav class="fg-nav channels" aria-label="${esc(o.channelsTitle || 'Channels')}">${chans.map((c) => item(c, String(c.id) === String(o.channel), 'channel')).join('')}</nav>` : ''}
        <div class="fg-side-foot">${o.user ? `<span class="fg-who">${esc(o.user)}</span>` : ''}<a href="${FG.HOME.url}">← All apps</a><a href="${esc(o.signOut || '/cdn-cgi/access/logout')}">Sign out</a></div>`;
    };
    side.addEventListener('click', (e) => {
      if (e.target.closest('.fg-apps-btn')) { menu = !menu; draw(); return; }
      const it = e.target.closest('[data-kind]'); if (!it || it.tagName === 'A') return;
      const id = (o.channels || []).concat(o.sections || []).find((x) => String(x.id) === it.dataset.id)?.id;
      if (it.dataset.kind === 'section') { o.current = id; o.onSection?.(id); } else { o.channel = id; o.onChannel?.(id); }
      draw();
    });
    document.addEventListener('pointerdown', (e) => { if (menu && !e.target.closest('.fg-apps')) { menu = false; draw(); } });
    document.addEventListener('keydown', (e) => { if (menu && e.key === 'Escape') { menu = false; draw(); } });
    const reorder = (kind) => (order) => { FG.store.set(FG.key(`nav:${kind}`), order); draw(); };
    FG.sortable(side, '.sections > [data-id]', () => [...side.querySelectorAll('.sections > [data-id]')].map((x) => x.dataset.id), reorder('sections'));
    FG.sortable(side, '.channels > [data-id]', () => [...side.querySelectorAll('.channels > [data-id]')].map((x) => x.dataset.id), reorder('channels'));
    draw();
    return { update(p) { Object.assign(o, p); draw(); } };
  };

  /* ---------- page filters: chips, search, toggles, selects; kept in the URL and per browser ----------
     FG.filters(barEl, { key, defs: [{key, type: 'chips'|'search'|'toggle'|'select', label, options: [[value, label]], default}],
       onChange(values) }) → { values, set(k, v), reset() }. URL wins over saved values. Controls go first in the bar. */
  FG.filters = (bar, o) => {
    const blank = (d) => (d.type === 'toggle' ? false : '');
    const defaults = () => Object.fromEntries(o.defs.map((d) => [d.key, d.default ?? blank(d)]));
    const q = new URLSearchParams(location.search);
    const fromUrl = o.defs.some((d) => q.has(d.key)) && Object.fromEntries(o.defs.map((d) => [d.key, q.has(d.key) ? (d.type === 'toggle' ? q.get(d.key) === '1' : q.get(d.key)) : (d.default ?? blank(d))]));
    const api = { values: fromUrl || { ...defaults(), ...FG.store.get(FG.key(`filters:${o.key}`), {}) } };
    const box = document.createElement('div'); box.className = 'fg-filters'; bar.prepend(box);
    const draw = () => {
      const v = api.values;
      box.innerHTML = o.defs.map((d) => {
        if (d.type === 'search') return `<input type="search" class="fg-input" data-k="${d.key}" placeholder="${esc(d.label)}" aria-label="${esc(d.label)}" value="${esc(v[d.key])}">`;
        if (d.type === 'select') return `<select class="fg-select" data-k="${d.key}" aria-label="${esc(d.label)}">${d.options.map(([val, l]) => `<option value="${esc(val)}"${String(v[d.key]) === String(val) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
        if (d.type === 'toggle') return `<button type="button" class="fg-chip${v[d.key] ? ' on' : ''}" data-k="${d.key}" aria-pressed="${!!v[d.key]}">${v[d.key] ? '☑' : '☐'} ${esc(d.label)}</button>`;
        return `<span class="fg-chips" role="group" aria-label="${esc(d.label || d.key)}">${d.options.map(([val, l]) =>
          `<button type="button" class="fg-chip${String(v[d.key]) === String(val) ? ' on' : ''}" data-k="${d.key}" data-v="${esc(val)}" aria-pressed="${String(v[d.key]) === String(val)}">${esc(l)}</button>`).join('')}</span>`;
      }).join('');
    };
    const commit = (redraw) => {
      FG.store.set(FG.key(`filters:${o.key}`), api.values);
      const url = new URLSearchParams(location.search);
      o.defs.forEach((d) => { const x = api.values[d.key]; if (x === (d.default ?? blank(d))) url.delete(d.key); else url.set(d.key, d.type === 'toggle' ? (x ? '1' : '0') : x); });
      try { history.replaceState(history.state, '', `${location.pathname}${url.toString() ? `?${url}` : ''}${location.hash}`); } catch { /* sandboxed */ }
      if (redraw) draw(); // not while typing in a search box (keeps focus)
      o.onChange?.(api.values);
    };
    api.set = (k, val) => { api.values = { ...api.values, [k]: val }; commit(o.defs.find((d) => d.key === k)?.type !== 'search'); };
    api.reset = () => { api.values = defaults(); commit(true); };
    api.changed = () => o.defs.some((d) => api.values[d.key] !== (d.default ?? blank(d)));
    box.addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (!b) return; const d = o.defs.find((x) => x.key === b.dataset.k); api.set(d.key, d.type === 'toggle' ? !api.values[d.key] : b.dataset.v); });
    box.addEventListener('input', (e) => { if (e.target.dataset.k && e.target.tagName === 'INPUT') api.set(e.target.dataset.k, e.target.value); });
    box.addEventListener('change', (e) => { if (e.target.dataset.k && e.target.tagName === 'SELECT') api.set(e.target.dataset.k, e.target.value); });
    draw();
    return api;
  };

  /* ---------- table ----------
     FG.table(wrapEl, { key, rows, id(r), cols: [{key, label, help, sort(r), cell(r) → HTML, f(r) → value (dropdown filter),
       show(v) → label, text(r) → text (search filter), cls, main}], keep(r) (page filters), defaultSort: {key, dir},
       select, onSelect(ids), onRow(r), rowClass(r), group: {by(r), label(g, rows) → HTML, order: [g]}, sub(r) → HTML | null,
       empty, cards, paged, onCount(shown, total) })
     → { setRows(rows), render(), picked: Set, shown(), reset() }.
     Click a header to sort; drag it to move; drag its edge to resize; double-click the edge to reset. Saved per browser. */
  FG.table = (wrap, o) => {
    wrap.classList.add('fg-table-wrap'); if (o.cards) wrap.classList.add('cards');
    const id = o.id || ((r) => r.id);
    const sk = FG.key(`table:${o.key}`);
    const st = { order: [], widths: null, sort: o.defaultSort || null, flt: {}, folded: [], groups: [], perPage: 25, ...FG.store.get(sk, {}) };
    const save = () => FG.store.set(sk, { order: st.order, widths: st.widths, sort: st.sort, flt: st.flt, folded: st.folded, groups: st.groups, perPage: st.perPage });
    const picked = new Set(); const open = new Set();
    let rows = o.rows || []; let shownIds = []; let page = 0;
    const NONE = '\u0000';
    const cols = () => FG.orderBy(o.cols, st.order, (c) => c.key);
    const span = () => cols().length + 1;
    wrap.innerHTML = '<table class="fg-table"><thead></thead><tbody></tbody></table><div class="fg-pager" hidden></div>';
    const table = wrap.querySelector('table'); const head = table.tHead; const body = table.tBodies[0]; const pager = wrap.querySelector('.fg-pager');

    const opts = (c) => [...new Set(rows.map((r) => c.f(r) ?? ''))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    const drawHead = () => {
      const cs = cols(); const fixed = !!st.widths; table.classList.toggle('fixed', fixed);
      const w = (k) => (fixed ? ` style="width:${st.widths[k] || 120}px"` : '');
      head.innerHTML = `<tr class="fg-hd"><th${w('_sel')} data-col-w="_sel">${o.select ? '<input type="checkbox" data-all aria-label="Select all shown">' : ''}</th>${cs.map((c, i) =>
        `<th data-id="${c.key}" data-col-w="${c.key}"${c.sort ? ` data-sort="${c.key}"` : ''} draggable="true" title="Click to sort · drag to move"${w(c.key)}
          class="${st.sort?.key === c.key ? (st.sort.dir > 0 ? 'asc' : 'desc') : ''}">${esc(c.label)}${c.help ? FG.info(c.help, i > cs.length / 2) : ''}<span class="fg-resize" title="Drag to resize · double-click to reset widths and order"></span></th>`).join('')}</tr>
        ${cs.some((c) => c.f || c.text) ? `<tr class="fg-flt"><th></th>${cs.map((c) => (c.text
          ? `<th><input type="search" data-flt="${c.key}" placeholder="Filter…" aria-label="Filter ${esc(c.label)}" value="${esc(st.flt[c.key] || '')}"></th>`
          : c.f ? `<th><select data-flt="${c.key}" aria-label="Filter ${esc(c.label)}"><option value="">${esc(c.label)}: all</option>${opts(c).map((v) => {
            const val = v === '' ? NONE : String(v);
            return `<option value="${esc(val)}"${(st.flt[c.key] || '') === val ? ' selected' : ''}>${v === '' ? '(none)' : esc(c.show ? c.show(v) : v)}</option>`; }).join('')}</select></th>` : '<th></th>')).join('')}</tr>` : ''}`;
    };
    const row = (r, n) => {
      const rid = String(id(r)); const sub = o.sub ? o.sub(r) : null;
      return `<tr data-id="${esc(rid)}" class="${o.rowClass ? o.rowClass(r) || '' : ''}${o.onRow ? ' link' : ''}"><td class="nowrap">${sub != null ? `<button type="button" class="fg-fold" data-sub="${esc(rid)}" aria-expanded="${open.has(rid)}" aria-label="Show details">${open.has(rid) ? '▾' : '▸'}</button>` : ''}${o.select
        ? `<input type="checkbox" data-sel="${esc(rid)}" aria-label="Select row ${n}"${picked.has(rid) ? ' checked' : ''}>` : `<span class="fg-muted">${n}</span>`}</td>${cols().map((c) =>
        `<td data-label="${esc(c.label)}" class="${c.cls || ''}${c.main ? ' main' : ''}">${c.cell ? c.cell(r) : esc(c.text ? c.text(r) : c.f ? c.f(r) : r[c.key])}</td>`).join('')}</tr>${sub != null && open.has(rid) ? `<tr class="fg-sub"><td colspan="${span()}">${sub}</td></tr>` : ''}`;
    };
    const render = () => {
      const by = Object.fromEntries(o.cols.map((c) => [c.key, c]));
      const val = (c, r) => { const x = c.f(r); return x === '' || x == null ? NONE : String(x); };
      const colOk = (r) => Object.entries(st.flt).every(([k, v]) => !v || !by[k] || (by[k].text
        ? String(by[k].text(r) ?? '').toLowerCase().includes(v.toLowerCase()) : val(by[k], r) === v));
      const sv = st.sort && by[st.sort.key]?.sort;
      let list = rows.filter((r) => (!o.keep || o.keep(r)) && colOk(r));
      if (sv) list = [...list].sort((a, b) => cmp(sv(a), sv(b)) * st.sort.dir || cmp(String(id(a)), String(id(b))));
      let html; let vis = list;
      if (o.group && (!o.group.active || o.group.active())) {
        const gids = [...new Set(list.map((r) => String(o.group.by(r))))];
        const ordered = FG.orderBy(FG.orderBy(gids, (o.group.order || []).map(String)), st.groups);
        vis = list.filter((r) => !st.folded.includes(String(o.group.by(r))));
        let n = 0;
        html = ordered.map((g) => { const gr = list.filter((r) => String(o.group.by(r)) === g); const shut = st.folded.includes(g);
          return `<tr class="fg-grp" data-id="${esc(g)}" draggable="true" title="Drag to move · click ▾ to fold"><td colspan="${span()}"><button type="button" class="fg-fold" data-fold="${esc(g)}" aria-expanded="${!shut}">${shut ? '▸' : '▾'}</button> ${o.group.label ? o.group.label(g, gr) : `<b>${esc(g)}</b>`} <span class="fg-muted">${gr.length}</span></td></tr>${shut ? '' : gr.map((r) => row(r, ++n)).join('')}`; }).join('');
        pager.hidden = true;
      } else {
        const per = st.perPage; const paged = o.paged && list.length > 25; if (!paged || page * per >= list.length) page = 0;
        vis = paged ? list.slice(page * per, (page + 1) * per) : list;
        html = vis.map((r, i) => row(r, (paged ? page * per : 0) + i + 1)).join('');
        pager.hidden = !paged;
        if (paged) pager.innerHTML = `<button type="button" class="fg-btn ghost small" data-pg="-1"${page === 0 ? ' disabled' : ''}>◀ Prev</button><span class="fg-count">${page * per + 1}–${Math.min(list.length, (page + 1) * per)} of ${list.length}</span><button type="button" class="fg-btn ghost small" data-pg="1"${(page + 1) * per >= list.length ? ' disabled' : ''}>Next ▶</button><select class="fg-select" data-per aria-label="Rows per page">${[25, 50, 100].map((n) => `<option${n === per ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
      }
      body.innerHTML = html || `<tr><td colspan="${span()}" class="empty">${esc(o.empty || 'Nothing to show.')}</td></tr>`;
      shownIds = vis.map((r) => String(id(r)));
      const all = head.querySelector('[data-all]');
      if (all) { all.checked = shownIds.length > 0 && shownIds.every((i) => picked.has(i)); all.indeterminate = !all.checked && shownIds.some((i) => picked.has(i)); }
      o.onCount?.(list.length, rows.length, Object.values(st.flt).some(Boolean));
    };
    const full = () => { drawHead(); render(); };
    const selChanged = () => { render(); o.onSelect?.([...picked]); };

    head.addEventListener('click', (e) => {
      if (e.target.closest('.fg-resize, .fg-info, input, select')) return;
      const th = e.target.closest('th[data-sort]'); if (!th) return;
      const k = th.dataset.sort; st.sort = { key: k, dir: st.sort?.key === k ? -st.sort.dir : 1 }; save(); full();
    });
    head.addEventListener('change', (e) => {
      if (e.target.matches('[data-all]')) { shownIds.forEach((i) => (e.target.checked ? picked.add(i) : picked.delete(i))); selChanged(); }
      else if (e.target.dataset.flt && e.target.tagName === 'SELECT') { st.flt[e.target.dataset.flt] = e.target.value; save(); render(); }
    });
    head.addEventListener('input', (e) => { if (e.target.dataset.flt && e.target.type === 'search') { st.flt[e.target.dataset.flt] = e.target.value; save(); render(); } });
    head.addEventListener('dblclick', (e) => { if (e.target.closest('.fg-resize')) { st.order = []; st.widths = null; save(); full(); } });
    head.addEventListener('pointerdown', (e) => {
      const h = e.target.closest('.fg-resize'); if (!h) return; e.preventDefault(); e.stopPropagation();
      const th = h.closest('th'); const k = th.dataset.colW;
      st.widths = st.widths || Object.fromEntries([...head.querySelectorAll('tr.fg-hd th')].map((x) => [x.dataset.colW, Math.round(x.getBoundingClientRect().width)]));
      table.classList.add('fixed'); th.draggable = false; // resizing, not moving
      const x0 = e.clientX; const w0 = st.widths[k] || th.getBoundingClientRect().width;
      head.querySelectorAll('tr.fg-hd th').forEach((x) => { x.style.width = `${st.widths[x.dataset.colW]}px`; });
      const move = (ev) => { st.widths[k] = Math.max(40, Math.round(w0 + ev.clientX - x0)); th.style.width = `${st.widths[k]}px`; };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); th.draggable = true; save(); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    head.addEventListener('click', (e) => { if (e.target.closest('.fg-resize')) e.stopPropagation(); }, true);
    FG.sortable(head, 'tr.fg-hd th[data-id]', () => cols().map((c) => c.key), (order) => { st.order = order; save(); full(); });
    FG.sortable(body, 'tr.fg-grp', () => [...body.querySelectorAll('tr.fg-grp')].map((x) => x.dataset.id), (order) => { st.groups = order; save(); render(); });
    body.addEventListener('change', (e) => { const i = e.target.dataset?.sel; if (i == null) return; if (e.target.checked) picked.add(i); else picked.delete(i); selChanged(); });
    body.addEventListener('click', (e) => {
      const f = e.target.closest('[data-fold]'); if (f) { const g = f.dataset.fold; st.folded = st.folded.includes(g) ? st.folded.filter((x) => x !== g) : [...st.folded, g]; save(); render(); return; }
      const s = e.target.closest('[data-sub]'); if (s) { const i = s.dataset.sub; if (open.has(i)) open.delete(i); else open.add(i); render(); return; }
      if (!o.onRow || e.target.closest('input, button, a, select, label, .fg-info')) return;
      const tr = e.target.closest('tr[data-id]'); if (!tr || tr.classList.contains('fg-grp')) return;
      const r = rows.find((x) => String(id(x)) === tr.dataset.id); if (r) o.onRow(r);
    });
    pager.addEventListener('click', (e) => { const b = e.target.closest('[data-pg]'); if (b) { page += Number(b.dataset.pg); render(); } });
    pager.addEventListener('change', (e) => { if (e.target.matches('[data-per]')) { st.perPage = Number(e.target.value); page = 0; save(); render(); } });

    const api = {
      picked,
      shown: () => [...shownIds],
      render,
      setRows(next) {
        rows = next || []; const keep = new Set(rows.map((r) => String(id(r)))); [...picked].forEach((i) => { if (!keep.has(i)) picked.delete(i); });
        // a dropdown filter whose value no row has any more would hide everything: drop it
        for (const c of o.cols) if (c.f && st.flt[c.key] && !rows.some((r) => { const x = c.f(r); return (x === '' || x == null ? NONE : String(x)) === st.flt[c.key]; })) delete st.flt[c.key];
        full();
      },
      setCols(next) { o.cols = next; full(); }, // columns that depend on data (e.g. one per app)
      reset() { st.flt = {}; save(); full(); }, // clears the column filters
      state: st,
    };
    full();
    return api;
  };

  /* ---------- sections: cards that fold and move ----------
     Markup: <div id="cards"><section class="fg-section" data-id="a"><div class="fg-section-head"><span class="fg-handle">⠿</span>
       <span class="fg-chev">▾</span><h2>Title</h2></div><div class="fg-section-body">…</div></section> …</div>
     FG.sections(containerEl, { key }) — head click folds; ⠿ drag moves; double-click ⠿ resets. Saved per browser. */
  FG.sections = (box, o) => {
    const sk = FG.key(`sections:${o.key}`);
    const all = () => [...box.querySelectorAll(':scope > .fg-section[data-id]')];
    const initial = all().map((s) => s.dataset.id);
    let st = { order: [], folded: [], ...FG.store.get(sk, {}) };
    const apply = () => {
      FG.orderBy(all(), st.order, (s) => s.dataset.id).forEach((s) => box.append(s));
      all().forEach((s) => { const f = st.folded.includes(s.dataset.id); s.classList.toggle('folded', f); s.querySelector('.fg-section-head')?.setAttribute('aria-expanded', String(!f)); });
    };
    const save = () => { FG.store.set(sk, st); apply(); };
    all().forEach((s) => { const h = s.querySelector('.fg-section-head'); if (h) { h.tabIndex = 0; h.setAttribute('role', 'button'); } });
    box.addEventListener('click', (e) => {
      const h = e.target.closest('.fg-section-head'); if (!h || e.target.closest('.fg-handle, button, a, input, select')) return;
      const i = h.closest('.fg-section').dataset.id; st.folded = st.folded.includes(i) ? st.folded.filter((x) => x !== i) : [...st.folded, i]; save();
    });
    box.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.fg-section-head')) { e.preventDefault(); e.target.click(); } });
    box.addEventListener('dblclick', (e) => { if (e.target.closest('.fg-handle')) { st = { order: initial, folded: [] }; save(); } });
    FG.sortable(box, '.fg-section[data-id]', () => all().map((s) => s.dataset.id), (order) => { st.order = order; save(); }, '.fg-handle');
    apply();
    return { reset() { st = { order: initial, folded: [] }; save(); } };
  };
})();
