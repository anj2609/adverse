'use strict';
/* AdForge dashboard. No build step: plain modules of render functions plus a hash router. */

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n) => Number(n || 0).toLocaleString();
const pct = (n) => `${(n * 100).toFixed(n && n < 0.1 ? 2 : 1)}%`;
const media = (f) => `/media/${f}`;
const dt = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const dOnly = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const toInput = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromInput = (v) => (v ? new Date(v).toISOString() : null);
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`; };
const window_ = (s, en) => (!s && !en ? 'Always' : `${s ? dOnly(s) : 'Now'} → ${en ? dOnly(en) : 'no end date'}`);

const state = { user: null, token: localStorage.getItem('adforge_token') };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { logout(); throw new Error('Your session ended. Please sign in again.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : ''); t.textContent = msg;
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3000);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (err) { toast(err.message, true); } };

function logout() { localStorage.removeItem('adforge_token'); state.token = null; state.user = null; location.hash = '#/login'; }

const STATUS_LABEL = { active: 'Running', scheduled: 'Starts later', paused: 'Paused', expired: 'Ended', draft: 'Not turned on', live: 'Showing', ended: 'Ended', inactive: 'Off' };
const pill = (s) => `<span class="pill ${e(s)}">${STATUS_LABEL[s] || e(s)}</span>`;

const ICONS = {
  home: '<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>', apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  camp: '<path d="M3 11v2a2 2 0 0 0 2 2h2l5 4V5L7 9H5a2 2 0 0 0-2 2zM16 8a5 5 0 0 1 0 8"/>', log: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24">${ICONS[n]}</svg>`;

// ---------- modal ----------
function modal({ title, body, actions = [], wide = false, onMount }) {
  const root = $('#modal-root');
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${e(title)}">
    <header><h2>${e(title)}</h2><button class="x" aria-label="Close">×</button></header>
    <div class="body">${body}</div>${actions.length ? '<footer></footer>' : ''}</div>`;
  root.appendChild(scrim);
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('mousedown', (ev) => { if (ev.target === scrim) close(); });
  $('.x', scrim).onclick = close;
  const foot = $('footer', scrim);
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`; b.textContent = a.label;
    b.onclick = async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try { const r = await a.onClick(scrim); if (r !== false) close(); } catch (err) { toast(err.message, true); }
      b.disabled = false;
    };
    foot.appendChild(b);
  }
  onMount?.(scrim, close);
  const first = $('input, select, textarea', scrim); first?.focus();
  return { close, el: scrim };
}
const confirmBox = (title, msg, label, fn, danger) => modal({ title, body: `<p>${msg}</p>`, actions: [{ label: 'Cancel' }, { label, primary: !danger, danger, onClick: fn }] });

// ---------- chart ----------
function chart(days, { height = 180 } = {}) {
  if (!days.length) return '<div class="empty small">No views yet</div>';
  const W = 720, H = height, pad = { l: 38, r: 12, t: 10, b: 24 };
  const maxI = Math.max(1, ...days.map((d) => d.impressions)), maxC = Math.max(1, ...days.map((d) => d.clicks));
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (v, m) => pad.t + (H - pad.t - pad.b) * (1 - v / m);
  const bars = days.map((d, i) => `<rect class="bar" x="${pad.l + i * bw + bw * 0.15}" y="${y(d.impressions, maxI)}" width="${bw * 0.7}" height="${H - pad.b - y(d.impressions, maxI)}" rx="3"><title>${e(d.day)}: ${nf(d.impressions)} views, ${nf(d.clicks)} taps</title></rect>`).join('');
  const pts = days.map((d, i) => [pad.l + i * bw + bw / 2, y(d.clicks, maxC)]);
  const labelEvery = Math.ceil(days.length / 7);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Views and taps per day">
    ${[0, 0.5, 1].map((f) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(maxI * f, maxI)}" y2="${y(maxI * f, maxI)}"/><text x="${pad.l - 6}" y="${y(maxI * f, maxI) + 3}" text-anchor="end">${nf(Math.round(maxI * f))}</text>`).join('')}
    ${bars}<polyline class="line" points="${pts.map((p) => p.join(',')).join(' ')}"/>${pts.map((p) => `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="2.6"/>`).join('')}
    ${days.map((d, i) => (i % labelEvery === 0 ? `<text x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${e(d.day.slice(5))}</text>` : '')).join('')}</svg>
    <div class="legend"><span><i style="background:var(--accent)"></i>Views</span><span><i style="background:var(--ok)"></i>Taps (smaller scale)</span></div>`;
}

// ---------- shell ----------
function shell(active, content) {
  const nav = [['#/', 'home', 'Overview'], ['#/apps', 'apps', 'Applications'], ['#/campaigns', 'camp', 'Campaigns'], ['#/audit', 'log', 'Activity log']];
  const u = state.user;
  $('#root').innerHTML = `<div class="shell"><aside class="side">
    <div class="brand"><i><svg viewBox="0 0 32 32"><path d="M9 22 16 8l7 14h-4l-3-6-3 6z"/></svg></i>AdForge</div>
    <nav class="nav" aria-label="Main">${nav.map(([h, i, l]) => `<a href="${h}" class="${active === h ? 'on' : ''}">${icon(i)}<span>${l}</span></a>`).join('')}</nav>
    <div class="me"><strong>${e(u.name)}</strong><span class="small muted">${u.role === 'admin' ? 'Administrator' : e(u.advertiser?.name || 'Advertiser')}</span><button class="btn sm" id="logout">Sign out</button></div>
  </aside><main class="main" id="main">${content}</main></div>`;
  $('#logout').onclick = logout;
}

// ---------- login ----------
function loginPage() {
  $('#root').innerHTML = `<div class="login"><form class="card stack" id="lf">
    <div class="brand" style="padding:0"><i><svg viewBox="0 0 32 32"><path d="M9 22 16 8l7 14h-4l-3-6-3 6z"/></svg></i>AdForge</div>
    <div><h1>Sign in</h1><p class="muted" style="margin:4px 0 0">Manage ad placements across your Flutter apps.</p></div>
    <label class="f">Email<input type="email" name="email" autocomplete="username" required autofocus></label>
    <label class="f">Password<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn primary" style="justify-content:center">Sign in</button>
    <p class="small muted" style="margin:0">Demo: admin@adforge.local, or an advertiser like aqua@adforge.local. Password adforge123.</p></form></div>`;
  $('#lf').onsubmit = guard(async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const r = await api('/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
    state.token = r.token; state.user = r.user; localStorage.setItem('adforge_token', r.token);
    location.hash = '#/';
  });
}

// ---------- overview ----------
async function overviewPage() {
  const o = await api('/overview');
  const c = o.campaigns, a = o.last14;
  const kpi = (l, v, d = '') => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  const rej = o.rejected.reduce((s, r) => s + r.n, 0);
  shell('#/', `<div class="page-head"><div><h1>Overview</h1><div class="sub">Last 14 days across ${state.user.role === 'admin' ? 'all apps' : 'your campaigns'}.</div></div></div>
    <div class="grid g4" style="margin-bottom:16px">
      ${kpi('Campaigns running now', nf(c.active), `${nf(c.scheduled)} waiting to start · ${nf(c.paused)} paused`)}
      ${kpi('Views', nf(a.impressions), `seen on ${nf(a.devices)} different phones`)}
      ${kpi('Taps', nf(a.clicks), 'people who tapped an ad')}
      ${kpi('Tap rate', pct(a.ctr), 'taps out of every view')}
    </div>
    <div class="grid g2" style="grid-template-columns:2fr 1fr;align-items:start">
      <div class="card"><div class="card-head"><h2>Views and taps each day</h2></div>${chart(a.by_day)}</div>
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Starting and ending soon</h2></div>${o.upcoming.length ? `<ul class="timeline">${o.upcoming.map((u) => `<li><span class="dot"></span><div><a href="#/campaigns/${u.id}">${e(u.name)}</a><div class="small muted">${u.status === 'scheduled' ? `Starts ${dt(u.start_at)}` : `Ends ${dt(u.end_at)}`}</div></div></li>`).join('')}</ul>` : '<p class="muted">Nothing starting or ending soon.</p>'}</div>
        ${state.user.role === 'admin' ? `<div class="card"><div class="card-head"><h2>Are the numbers real?</h2></div>
          <p class="muted" style="margin:0 0 10px">A view only counts if the ad was on screen for at least a second and came from AdForge. Anything else is thrown out:</p>
          ${o.rejected.length ? o.rejected.map((r) => `<div class="row small" style="justify-content:space-between"><span>${e(REJECT_LABEL[r.reason] || r.reason)}</span><span class="muted">${nf(r.n)}</span></div>`).join('') : ''}
          <div class="small muted" style="margin-top:8px">${nf(rej)} reports thrown out in total</div></div>` : ''}
      </div></div>`);
}
const REJECT_LABEL = { duplicate: 'Same view sent twice', not_viewable: 'Not on screen for a full second', bad_token: 'Fake or tampered report', token_expired: 'Report too old', wrong_app: 'Report from a different app', bad_device: 'Report with no phone id', unknown_campaign: 'Campaign was deleted', bad_type: 'Unrecognised report' };

// ---------- apps ----------
async function appsPage() {
  const apps = await api('/apps');
  shell('#/apps', `<div class="page-head"><div><h1>Applications</h1><div class="sub">Every app made by TrendPilot, and the places inside each one where ads can go.</div></div></div>
    <div class="grid auto">${apps.map((a) => `<a class="card flush" href="#/apps/${a.id}/placements" style="color:inherit;text-decoration:none">
      <div class="app-cover">${a.cover ? `<img src="${media(a.cover)}" alt="">` : ''}</div>
      <div style="padding:16px"><div class="row"><h2>${e(a.name)}</h2><span class="tag right">${e(a.category || 'App')}</span></div>
      <div class="small muted" style="margin:2px 0 12px">v${e(a.version || '—')} · ${e(a.platform)} · ${e(a.source)}</div>
      <div class="row small"><span><strong>${a.placements}</strong> ad spots</span><span><strong>${a.live_placements}</strong> showing an ad</span><span><strong>${a.active_campaigns}</strong> campaigns running</span></div></div></a>`).join('')}</div>`);
}

async function appPage(id, tab) {
  const app = await api(`/apps/${id}`);
  const tabs = [['placements', 'Ad spots'], ['creatives', 'Ad images'], ['campaigns', 'Campaigns'], ['preview', 'Preview'], ['history', 'Ad spot history'], ['analytics', 'Results']];
  if (state.user.role !== 'admin') tabs.splice(4, 1);
  shell('#/apps', `<div class="crumbs"><a href="#/apps">Applications</a> / ${e(app.name)}</div>
    <div class="page-head"><div><h1>${e(app.name)}</h1><div class="sub">${e(app.category || '')} · v${e(app.version || '—')} · made by ${e(app.source)} · Flutter app</div></div>
    ${state.user.role === 'admin' ? `<button class="btn right" id="sdkkey">SDK setup</button>` : ''}</div>
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" role="tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="tabbody"><div class="muted">Loading…</div></div>`);
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => (location.hash = `#/apps/${id}/${b.dataset.tab}`)));
  const sdk = $('#sdkkey'); if (sdk) sdk.onclick = guard(() => sdkSetup(app));
  const body = $('#tabbody');
  const fn = { placements: tabPlacements, creatives: tabCreatives, campaigns: tabCampaigns, preview: tabPreview, history: tabHistory, analytics: tabAppAnalytics }[tab] || tabPlacements;
  await fn(app, body);
}

async function sdkSetup(app) {
  // The key is not in the app payload; admins read it from the dedicated field.
  const r = await api(`/apps/${app.id}/sdk`);
  modal({ title: `Connect ${app.name} to AdForge`, wide: true, actions: [{ label: 'Done', primary: true }], body: `
    <p>Paste this into the app's <span class="mono">main.dart</span>. TrendPilot does this automatically for generated apps.</p>
    <pre class="card mono" style="overflow:auto;margin:0;background:var(--surface-2)">await AdForge.init(
  baseUrl: '${e(location.origin)}',
  appKey: '${e(r.sdk_key)}',
);
runApp(AdForge.wrap(const MyApp()));</pre>
    <p class="muted small">Spots marked "asset" swap automatically when the app loads an image with the matching file name. Spots marked "widget" use <span class="mono">AdForgePlacement(spot: 'key', child: …)</span>.</p>` });
}

function shapeLabel(p) { return `${p.px_w}×${p.px_h}px`; }

async function tabPlacements(app, body) {
  body.innerHTML = `<div class="grid auto">${app.placements.map((p) => `<button class="card flush" data-p="${p.id}" style="text-align:left;cursor:pointer;color:inherit">
    <div class="app-cover" style="height:140px">${p.original_file ? `<img src="${media(p.original_file)}" alt="Original asset for ${e(p.name)}">` : ''}</div>
    <div style="padding:14px 16px"><div class="row"><h3>${e(p.name)}</h3><span class="right">${p.live ? pill('live') : '<span class="tag">Original picture</span>'}</span></div>
    <div class="small muted" style="margin:4px 0 8px">${e(p.location || '')}</div>
    <div class="row small"><span class="tag">${shapeLabel(p)}</span><span class="tag">${e(p.formats.join(' / ').toUpperCase())}</span><span class="tag">${p.integration === 'widget' ? 'Placed in code' : 'Automatic swap'}</span></div>
    ${p.live ? `<div class="small" style="margin-top:8px">Now: <strong>${e(p.live.advertiser)}</strong> · ${e(p.live.campaign_name)}</div>` : ''}</div></button>`).join('')}</div>`;
  body.querySelectorAll('[data-p]').forEach((b) => (b.onclick = guard(() => placementDetail(b.dataset.p))));
}

async function placementDetail(pid) {
  const { placement: p, campaigns, history } = await api(`/placements/${pid}`);
  modal({ title: p.name, wide: true, actions: [{ label: 'Close', primary: true }], body: `
    <div class="grid g2" style="grid-template-columns:1.1fr 1fr">
      <div class="stack"><div class="small muted">Original picture</div><img class="thumb lg" src="${media(p.original_file)}" alt="Original picture"><div class="mono muted">${e(p.match_image || p.key)}</div></div>
      <div class="stack">
        <div><div class="small muted">Where it shows up in the app</div><div>${e(p.location || '—')}</div></div>
        <div><div class="small muted">Picture size needed</div><div>${shapeLabel(p)} · ${(p.px_w / p.px_h).toFixed(2)}:1</div></div>
        <div><div class="small muted">File types accepted</div><div>${e(p.formats.join(', ').toUpperCase())}</div></div>
        <div><div class="small muted">How the picture is placed</div><div>${p.fit === 'cover' ? 'Fills the space (edges may be trimmed a little)' : 'Whole picture shown, nothing trimmed'}</div></div>
        <div><div class="small muted">How the app picks it up</div><div>${p.integration === 'widget' ? `Placed in the app's code as <span class="mono">${e(p.key)}</span>` : `Automatic: swaps the app's picture named <span class="mono">${e(p.match_image)}</span>`}</div></div>
      </div></div>
    <h3 style="margin:20px 0 8px">Campaigns using this spot (${campaigns.length})</h3>
    ${campaigns.length ? campaigns.map((c) => `<div class="pl-row"><img class="thumb sm" src="${media(c.file)}" alt=""><div><a href="#/campaigns/${c.campaign_id}">${e(c.campaign_name)}</a><div class="small muted">${e(c.creative_name)} · ${window_(c.start_at || c.cs, c.end_at || c.ce)}</div></div><span class="right">${pill(c.state === 'enabled' ? 'active' : c.state)}</span></div>`).join('') : '<p class="muted">No campaign is using this spot yet.</p>'}
    <h3 style="margin:20px 0 8px">What has been shown here</h3>${historyList(history)}` });
  document.querySelectorAll('.modal a').forEach((a) => a.addEventListener('click', () => $('.scrim')?.remove()));
}

function historyList(rows) {
  if (!rows.length) return '<p class="muted">Only the original picture has ever been shown.</p>';
  return `<ul class="timeline">${rows.map((h) => `<li><span class="dot ${h.change === 'original' ? 'orig' : ''}"></span>
    ${h.file ? `<img class="thumb sm" src="${media(h.file)}" alt="">` : ''}<div><div>${e(h.note || h.change)}${h.placement_name ? ` <span class="muted">· ${e(h.placement_name)}</span>` : ''}</div>
    <div class="small muted">${dt(h.ts)}${h.campaign_name ? ` · ${e(h.campaign_name)}` : ''}</div></div></li>`).join('')}</ul>`;
}

async function tabHistory(app, body) {
  const rows = await api(`/apps/${app.id}/history`);
  body.innerHTML = `<div class="card"><div class="card-head"><h2>Ad spot history</h2><span class="muted small">Every time a spot changed from the original picture to an ad, or back.</span></div>${historyList(rows)}</div>`;
}

// ---------- creatives ----------
async function tabCreatives(app, body) {
  const [creatives, advs] = await Promise.all([api(`/apps/${app.id}/creatives`), api('/advertisers')]);
  const isAdmin = state.user.role === 'admin';
  body.innerHTML = `<div class="card stack" style="margin-bottom:16px"><div class="row"><h2>Upload ad images</h2>${isAdmin ? `<label class="f right" style="flex-direction:row;align-items:center;gap:8px">For <select id="adv" style="width:auto">${advs.map((a) => `<option value="${a.id}">${e(a.name)}</option>`).join('')}</select></label>` : ''}</div>
    <label class="drop" id="drop" tabindex="0"><input id="files" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
      <strong>Drop images here, or click to choose</strong><div class="small">PNG, JPG or WebP · up to 8 MB each · you can pick several at once</div></label>
    <div class="small muted">Tip: use the size each spot needs so the picture isn't stretched. ${app.placements.map((p) => `${e(p.name)} ${shapeLabel(p)}`).join(' · ')}</div><div id="upstat"></div></div>
    ${creatives.length ? `<div class="grid auto" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">${creatives.map((c) => `<div class="card flush"><div class="app-cover" style="height:110px"><img src="${media(c.file)}" alt="${e(c.name)}" loading="lazy"></div>
      <div style="padding:12px 14px"><div class="row"><strong class="small">${e(c.name)}</strong></div><div class="small muted">${e(c.advertiser)} · ${c.width}×${c.height} · ${c.format.toUpperCase()}</div>
      <div class="small" style="margin:6px 0">Works for: ${c.fits.length ? c.fits.map((id) => `<span class="tag">${e(app.placements.find((p) => p.id === id)?.name || '')}</span>`).join(' ') : '<span class="muted">no spot in this app</span>'}</div>
      <button class="btn sm danger" data-del="${c.id}">Remove</button></div></div>`).join('')}</div>` : '<div class="card empty"><h3>No ad images yet</h3>Upload pictures above, then use them in a campaign.</div>'}`;

  const input = $('#files'), drop = $('#drop');
  const send = guard(async (list) => {
    list = [...list].filter((f) => /^image\//.test(f.type));
    if (!list.length) return toast('Choose image files', true);
    $('#upstat').innerHTML = `<div class="callout">Uploading ${list.length} image${list.length > 1 ? 's' : ''}…</div>`;
    const read = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res({ name: f.name, data: String(r.result).split(',')[1] }); r.onerror = rej; r.readAsDataURL(f); });
    let made = 0; const failed = [];
    for (let i = 0; i < list.length; i += 10) {
      const files = await Promise.all(list.slice(i, i + 10).map(read));
      const r = await api(`/apps/${app.id}/creatives`, { method: 'POST', body: { files, advertiser_id: $('#adv')?.value } });
      made += r.created.length; failed.push(...r.failed);
    }
    if (failed.length) toast(`${made} uploaded. Couldn't use: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`, true); else toast(`${made} image${made > 1 ? 's' : ''} uploaded`);
    tabCreatives(app, body);
  });
  input.onchange = () => send(input.files);
  drop.ondragover = (ev) => { ev.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (ev) => { ev.preventDefault(); drop.classList.remove('over'); send(ev.dataTransfer.files); };
  drop.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); } };
  body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => confirmBox('Remove this ad image?', 'It will not be available for new campaigns. Past results are kept.', 'Remove', guard(async () => { await api(`/creatives/${b.dataset.del}`, { method: 'DELETE' }); toast('Removed'); tabCreatives(app, body); }), true)));
}

// ---------- campaigns ----------
function campaignTable(rows, { showApp = true } = {}) {
  if (!rows.length) return '<div class="card empty"><h3>No campaigns yet</h3>Create one to start swapping pictures in an app.</div>';
  return `<div class="card flush table-wrap"><table><thead><tr><th>Campaign</th>${showApp ? '<th>App</th>' : ''}<th>Advertiser</th><th>Status</th><th>Runs</th><th class="num">Spots</th><th class="num">Views</th><th class="num">Tap rate</th></tr></thead><tbody>
    ${rows.map((c) => `<tr class="click" data-c="${c.id}"><td><strong>${e(c.name)}</strong><div class="small muted">Importance ${c.priority} of 10</div></td>${showApp ? `<td>${e(c.app_name)}</td>` : ''}<td>${e(c.advertiser)}</td>
      <td>${pill(c.status)}</td><td class="small nowrap">${window_(c.start_at, c.end_at)}</td><td class="num">${c.items}</td><td class="num">${nf(c.impressions)}</td><td class="num">${c.impressions ? pct(c.clicks / c.impressions) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}
const bindRows = (root) => root.querySelectorAll('[data-c]').forEach((r) => (r.onclick = () => (location.hash = `#/campaigns/${r.dataset.c}`)));

async function tabCampaigns(app, body) {
  const rows = await api(`/campaigns?app_id=${app.id}`);
  body.innerHTML = `<div class="row" style="margin-bottom:14px"><h2>Campaigns for ${e(app.name)}</h2><button class="btn primary right" id="newc">New campaign</button></div>${campaignTable(rows, { showApp: false })}`;
  bindRows(body); $('#newc').onclick = () => newCampaign(app.id);
}

async function campaignsPage() {
  const [rows, apps] = await Promise.all([api('/campaigns'), api('/apps')]);
  shell('#/campaigns', `<div class="page-head"><div><h1>Campaigns</h1><div class="sub">All campaigns, newest first.</div></div>
    <button class="btn primary right" id="newc">New campaign</button></div>${campaignTable(rows)}`);
  bindRows($('#main'));
  $('#newc').onclick = () => newCampaign(null, apps);
}

async function newCampaign(appId, apps) {
  apps = apps || (await api('/apps'));
  const advs = await api('/advertisers');
  modal({ title: 'New campaign', body: `<form class="stack" id="ncf">
    <label class="f">Name<input type="text" name="name" required maxlength="80" placeholder="Summer launch"></label>
    <div class="grid g2"><label class="f">App<select name="app_id">${apps.map((a) => `<option value="${a.id}" ${a.id === appId ? 'selected' : ''}>${e(a.name)}</option>`).join('')}</select></label>
    <label class="f">Advertiser<select name="advertiser_id" ${state.user.role === 'advertiser' ? 'disabled' : ''}>${advs.map((a) => `<option value="${a.id}">${e(a.name)}</option>`).join('')}</select></label></div>
    <div class="grid g2"><label class="f">Starts<input type="datetime-local" name="start_at"><span class="hint">Leave empty to start as soon as you turn it on</span></label>
    <label class="f">Ends<input type="datetime-local" name="end_at"><span class="hint">Leave empty to run until you stop it</span></label></div>
    <label class="f">How important (1–10)<input type="number" name="priority" min="1" max="10" value="5"><span class="hint">If two campaigns want the same spot, the higher number gets it.</span></label></form>`,
  actions: [{ label: 'Cancel' }, { label: 'Create campaign', primary: true, onClick: async (m) => {
    const f = new FormData($('#ncf', m));
    const c = await api('/campaigns', { method: 'POST', body: { name: f.get('name'), app_id: f.get('app_id'), advertiser_id: f.get('advertiser_id'), priority: f.get('priority'), start_at: fromInput(f.get('start_at')), end_at: fromInput(f.get('end_at')) } });
    toast('Campaign created. Now choose which pictures to swap.'); location.hash = `#/campaigns/${c.id}`;
  } }] });
}

async function campaignPage(id, tab = 'assets') {
  const c = await api(`/campaigns/${id}`);
  const app = await api(`/apps/${c.app_id}`);
  const canEdit = c.status !== 'expired';
  const acts = [];
  if (c.state === 'draft') acts.push(['activate', 'Turn on', 'primary']);
  if (c.state === 'paused') acts.push(['activate', 'Resume', 'primary']);
  if (c.state === 'enabled') acts.push(['pause', 'Pause', '']);
  if (canEdit && c.state !== 'draft') acts.push(['expire', 'End campaign', 'danger']);
  shell('#/campaigns', `<div class="crumbs"><a href="#/campaigns">Campaigns</a> / <a href="#/apps/${c.app_id}/campaigns">${e(c.app_name)}</a></div>
    <div class="page-head"><div><div class="row"><h1>${e(c.name)}</h1>${pill(c.status)}</div>
      <div class="sub">${e(c.advertiser)} on ${e(c.app_name)} · ${window_(c.start_at, c.end_at)} · priority ${c.priority}</div></div>
      <div class="row right">${acts.map(([a, l, k]) => `<button class="btn ${k}" data-act="${a}">${l}</button>`).join('')}
        ${canEdit ? '<button class="btn" id="editc">Edit details</button>' : ''}<button class="btn" id="dup">Copy</button>${c.state === 'draft' ? '<button class="btn danger" id="delc">Delete</button>' : ''}</div></div>
    ${c.status === 'scheduled' ? `<div class="callout" style="margin-bottom:16px">Waiting to start. It will go live by itself on ${dt(c.start_at)}.</div>` : ''}
    ${c.status === 'draft' ? '<div class="callout warn" style="margin-bottom:16px">Not turned on yet. Nothing shows in the app until you turn it on.</div>' : ''}
    ${c.status === 'expired' ? '<div class="callout bad" style="margin-bottom:16px">This campaign has ended. Its results stay here. Copy it to run it again.</div>' : ''}
    <div class="tabs">${[['assets', 'Pictures'], ['preview', 'Preview'], ['analytics', 'Results'], ['activity', 'Activity']].map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="tabbody"></div>`);
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => (location.hash = `#/campaigns/${id}/${b.dataset.tab}`)));
  const reload = () => campaignPage(id, tab);
  document.querySelectorAll('[data-act]').forEach((b) => (b.onclick = guard(async () => {
    const act = b.dataset.act;
    const run = async () => { await api(`/campaigns/${id}/state`, { method: 'POST', body: { action: act } }); toast({ activate: 'Campaign turned on', pause: 'Campaign paused', expire: 'Campaign ended' }[act]); reload(); };
    if (act === 'expire') return confirmBox('End this campaign now?', 'Its pictures are replaced by the originals right away. An ended campaign cannot be restarted.', 'End campaign', guard(run), true);
    await run();
  })));
  const ed = $('#editc'); if (ed) ed.onclick = () => editCampaign(c, reload);
  $('#dup').onclick = guard(async () => { const n = await api(`/campaigns/${id}/duplicate`, { method: 'POST' }); toast('Copied. Not turned on yet.'); location.hash = `#/campaigns/${n.id}`; });
  const dl = $('#delc'); if (dl) dl.onclick = () => confirmBox('Delete this draft?', 'This removes the draft and its asset choices.', 'Delete', guard(async () => { await api(`/campaigns/${id}`, { method: 'DELETE' }); location.hash = '#/campaigns'; }), true);
  const body = $('#tabbody');
  if (tab === 'assets') await campAssets(c, app, body, reload);
  if (tab === 'preview') await campPreview(c, app, body);
  if (tab === 'analytics') await campAnalytics(c, body);
  if (tab === 'activity') await campActivity(c, body);
}

function editCampaign(c, reload) {
  modal({ title: 'Edit campaign', body: `<form class="stack" id="ecf"><label class="f">Name<input type="text" name="name" value="${e(c.name)}" required maxlength="80"></label>
    <div class="grid g2"><label class="f">Starts<input type="datetime-local" name="start_at" value="${toInput(c.start_at)}"></label><label class="f">Ends<input type="datetime-local" name="end_at" value="${toInput(c.end_at)}"></label></div>
    <label class="f">How important (1–10)<input type="number" name="priority" min="1" max="10" value="${c.priority}"></label></form>`,
  actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async (m) => {
    const f = new FormData($('#ecf', m));
    await api(`/campaigns/${c.id}`, { method: 'PATCH', body: { name: f.get('name'), priority: f.get('priority'), start_at: fromInput(f.get('start_at')), end_at: fromInput(f.get('end_at')) } });
    toast('Saved'); reload();
  } }] });
}

async function campAssets(c, app, body, reload) {
  const canEdit = c.status !== 'expired';
  const byPl = Object.fromEntries(c.items.map((i) => [i.placement_id, i]));
  const done = c.items.length;
  body.innerHTML = `<div class="row" style="margin-bottom:14px"><div><h2>Pictures being swapped</h2><div class="muted small">${done} of ${app.placements.length} ad spots are swapped in this campaign. Each one can have its own dates.</div></div>
    ${canEdit ? '<button class="btn primary right" id="repall">Swap every spot that fits…</button>' : ''}</div>
    <div class="card flush table-wrap"><table><thead><tr><th>Ad spot</th><th>Original</th><th></th><th>Ad picture</th><th>Status</th><th>Runs</th><th></th></tr></thead><tbody>
    ${app.placements.map((p) => { const i = byPl[p.id]; return `<tr><td><strong>${e(p.name)}</strong><div class="small muted">${shapeLabel(p)}</div></td>
      <td><img class="thumb sm" src="${media(p.original_file)}" alt=""></td><td class="arrow">→</td>
      <td>${i ? `<div class="row" style="flex-wrap:nowrap"><img class="thumb sm" src="${media(i.file)}" alt=""><div class="small"><div>${e(i.creative_name)}</div>${i.click_url ? `<div class="muted">${e(new URL(i.click_url).host)}</div>` : '<div class="muted">No link</div>'}</div></div>` : '<span class="muted">Keeps original picture</span>'}</td>
      <td>${i ? `${pill(i.status)}${i.outranked_by ? `<div class="small muted">Another campaign is shown instead: ${e(i.outranked_by)}</div>` : ''}${!i.enabled ? '<div class="small muted">Turned off</div>' : ''}` : ''}</td>
      <td class="small">${i ? window_(i.start_at, i.end_at) : ''}</td>
      <td class="nowrap">${canEdit ? `<button class="btn sm" data-edit="${p.id}">${i ? 'Change' : 'Swap'}</button> ${i ? `<button class="btn sm danger" data-rm="${p.id}">Remove</button>` : ''}` : ''}</td></tr>`; }).join('')}</tbody></table></div>`;
  const ra = $('#repall'); if (ra) ra.onclick = guard(() => replaceAll(c, app, reload));
  body.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = guard(() => editItem(c, app, app.placements.find((p) => p.id === b.dataset.edit), byPl[b.dataset.edit], reload))));
  body.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = guard(async () => { await api(`/campaigns/${c.id}/items/${b.dataset.rm}`, { method: 'DELETE' }); toast('Spot is back to its original picture'); reload(); })));
}

const fitDiff = (p, cr) => Math.abs(cr.width / cr.height - p.px_w / p.px_h) / (p.px_w / p.px_h);

async function editItem(c, app, p, item, reload) {
  const all = await api(`/apps/${app.id}/creatives`);
  const mine = all.filter((x) => x.advertiser_id === c.advertiser_id);
  let chosen = item?.creative_id || mine.find((x) => x.fits.includes(p.id))?.id || null;
  const m = modal({ title: `${p.name}`, wide: true, body: `<div class="stack">
    <div class="row"><div><div class="small muted">Original picture</div><img class="thumb md" src="${media(p.original_file)}" alt=""></div><div class="muted small">${e(p.location || '')}<br>Needs ${shapeLabel(p)} · ${e(p.formats.join(' or ').toUpperCase())}</div></div>
    <div><div class="small muted" style="margin-bottom:6px">Choose the ad picture</div>
    ${mine.length ? `<div class="picks" id="picks">${mine.map((x) => `<button type="button" class="pick ${x.id === chosen ? 'on' : ''}" data-id="${x.id}" ${x.fits.includes(p.id) ? '' : 'data-warn="1"'}><img src="${media(x.file)}" alt=""><span class="small"><strong>${e(x.name)}</strong><br><span class="muted">${x.width}×${x.height}</span></span>${x.fits.includes(p.id) ? '' : '<span class="small" style="color:var(--warn)">Wrong shape for this spot</span>'}</button>`).join('')}</div>` : `<div class="callout warn">${e(c.advertiser)} has no pictures for this app yet. Upload some on the Ad images tab.</div>`}</div>
    <div class="grid g2"><label class="f">Show from<input type="datetime-local" id="s" value="${toInput(item?.start_at)}"><span class="hint">Empty = from when the campaign starts</span></label>
    <label class="f">Show until<input type="datetime-local" id="en" value="${toInput(item?.end_at)}"><span class="hint">Empty = until the campaign ends</span></label></div>
    <label class="f">Where a tap takes people<input type="url" id="link" value="${e(item?.click_url || '')}" placeholder="https://advertiser.com/offer"><span class="hint">We count the tap, then people land on this page.</span></label>
    <label class="check"><input type="checkbox" id="on" ${item?.enabled === 0 ? '' : 'checked'}> Show this ad picture</label></div>`,
  actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async (mm) => {
    if (!chosen) throw new Error('Choose a picture first');
    await api(`/campaigns/${c.id}/items/${p.id}`, { method: 'PUT', body: { creative_id: chosen, start_at: fromInput($('#s', mm).value), end_at: fromInput($('#en', mm).value), click_url: $('#link', mm).value.trim(), enabled: $('#on', mm).checked } });
    toast('Saved'); reload();
  } }] });
  $('#picks', m.el)?.addEventListener('click', (ev) => {
    const b = ev.target.closest('.pick'); if (!b) return;
    chosen = b.dataset.id; m.el.querySelectorAll('.pick').forEach((x) => x.classList.toggle('on', x === b));
  });
}

async function replaceAll(c, app, reload) {
  const all = await api(`/apps/${app.id}/creatives`);
  const mine = all.filter((x) => x.advertiser_id === c.advertiser_id);
  if (!mine.length) return toast(`${c.advertiser} has no pictures for this app yet. Upload some on the Ad images tab.`, true);
  const selected = new Set(mine.map((x) => x.id));
  const plan = () => app.placements.map((p) => {
    const fits = mine.filter((x) => selected.has(x.id) && x.fits.includes(p.id)).sort((a, b) => fitDiff(p, a) - fitDiff(p, b));
    return { p, best: fits[0] || null };
  });
  const m = modal({ title: 'Swap every spot that fits', wide: true, body: `<div class="stack">
    <div><div class="small muted" style="margin-bottom:6px">Use these pictures</div><div class="picks" id="rpicks">${mine.map((x) => `<button type="button" class="pick on" data-id="${x.id}"><img src="${media(x.file)}" alt=""><span class="small"><strong>${e(x.name)}</strong><br><span class="muted">${x.width}×${x.height}</span></span></button>`).join('')}</div></div>
    <div><div class="small muted" style="margin-bottom:6px">Each spot gets the picture that fits it best. Spots with no fitting picture keep the original.</div><div id="plan"></div></div>
    <label class="check"><input type="checkbox" id="keep"> Don't change spots that already have a picture in this campaign</label>
    <label class="f">Where a tap takes people (optional, used for every spot)<input type="url" id="rlink" placeholder="https://advertiser.com/offer"></label></div>`,
  actions: [{ label: 'Cancel' }, { label: 'Swap them all', primary: true, onClick: async (mm) => {
    if (!selected.size) throw new Error('Choose at least one picture');
    const r = await api(`/campaigns/${c.id}/replace-all`, { method: 'POST', body: { creative_ids: [...selected], keep_existing: $('#keep', mm).checked, click_url: $('#rlink', mm).value.trim() } });
    toast(`${r.replaced.length} spot${r.replaced.length === 1 ? '' : 's'} swapped${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`); reload();
  } }] });
  const draw = () => {
    $('#plan', m.el).innerHTML = plan().map(({ p, best }) => `<div class="pl-row"><img class="thumb sm" src="${media(p.original_file)}" alt=""><span class="arrow">→</span>
      ${best ? `<img class="thumb sm" src="${media(best.file)}" alt=""><div><strong>${e(p.name)}</strong><div class="small muted">${e(best.name)}</div></div>` : `<div><strong>${e(p.name)}</strong><div class="small muted">No chosen picture fits ${shapeLabel(p)}, so it stays as it is.</div></div>`}</div>`).join('');
  };
  draw();
  $('#rpicks', m.el).addEventListener('click', (ev) => {
    const b = ev.target.closest('.pick'); if (!b) return;
    const id = b.dataset.id; selected.has(id) ? selected.delete(id) : selected.add(id); b.classList.toggle('on'); draw();
  });
}

// ---------- preview ----------
function phone(screens, placements, activeKey, { forceOriginal = false } = {}) {
  const sc = screens.find((s) => s.id === activeKey) || screens[0];
  if (!sc) return '<div class="empty">No screens</div>';
  const here = placements.filter((p) => p.screen_id === sc.id && p.w);
  const img = (p) => `<img src="${media(!forceOriginal && p.live ? p.live.file : p.original_file)}" alt="${e(p.name)}" title="${e(p.name)}" style="left:${p.x}%;top:${p.y}%;width:${p.w}%;height:${p.h}%;object-fit:${p.fit};z-index:${p.kind === 'background' ? 1 : 2 + 0}" class="${!forceOriginal && p.live ? 'ring' : ''}">`;
  return `<div class="phone"><div class="screen">${here.filter((p) => p.kind === 'background').map(img).join('')}
    ${sc.image_file ? `<img class="art" src="${media(sc.image_file)}" alt="" style="z-index:1">` : ''}${here.filter((p) => p.kind !== 'background').map(img).join('')}
    <span class="tagline">${e(sc.name)}</span></div></div>`;
}

async function previewUI(root, { app, campaigns = [], fixed = null }) {
  let mode = fixed ? 'selected' : 'live', picked = new Set(fixed ? [fixed] : []), at = '', screenId = null;
  const render = async () => {
    const q = mode === 'original' ? '?campaigns=none' : mode === 'selected' ? `?campaigns=${[...picked].join(',') || 'none'}` : at ? `?at=${encodeURIComponent(new Date(at).toISOString())}` : '';
    const pv = await api(`/apps/${app.id}/preview${q}`);
    screenId = screenId || pv.screens[0]?.id;
    root.innerHTML = `<div class="stack" style="margin-bottom:16px">
      ${fixed ? '' : `<div class="row"><div class="seg" id="mode">${[['live', 'What users see'], ['selected', 'Pick campaigns'], ['original', 'Original pictures']].map(([k, l]) => `<button class="${mode === k ? 'on' : ''}" data-m="${k}">${l}</button>`).join('')}</div>
        ${mode === 'live' ? `<label class="f" style="flex-direction:row;align-items:center;gap:8px">At this date and time <input type="datetime-local" id="at" value="${e(at)}" style="width:auto"></label>` : ''}</div>
        ${mode === 'selected' ? `<div class="row">${campaigns.map((c) => `<label class="check"><input type="checkbox" data-c="${c.id}" ${picked.has(c.id) ? 'checked' : ''}> ${e(c.name)} ${pill(c.status)}</label>`).join('') || '<span class="muted">No campaigns yet.</span>'}</div>
        <div class="callout">These campaigns are shown as if they were running now, whatever their dates.</div>` : ''}`}</div>
      <div class="preview"><div><div class="seg" id="scr" style="margin-bottom:12px;display:flex;flex-wrap:wrap">${pv.screens.map((s) => `<button class="${s.id === screenId ? 'on' : ''}" data-s="${s.id}">${e(s.name)}</button>`).join('')}</div>${phone(pv.screens, pv.placements, screenId, { forceOriginal: mode === 'original' })}</div>
      <div class="card"><h2 style="margin-bottom:6px">Ad spots in this app</h2><div class="small muted" style="margin-bottom:8px">${mode === 'original' ? 'Showing the original pictures.' : 'Outlined pictures are ads.'}</div>
      ${pv.placements.map((p) => `<div class="pl-row"><img class="thumb sm" src="${media(mode !== 'original' && p.live ? p.live.file : p.original_file)}" alt=""><div><strong>${e(p.name)}</strong><div class="small muted">${mode !== 'original' && p.live ? `${e(p.live.advertiser)} · ${e(p.live.campaign_name)}` : 'Original'}</div></div></div>`).join('')}</div></div>`;
    root.querySelectorAll('[data-m]').forEach((b) => (b.onclick = guard(() => { mode = b.dataset.m; return render(); })));
    root.querySelectorAll('[data-s]').forEach((b) => (b.onclick = guard(() => { screenId = b.dataset.s; return render(); })));
    root.querySelectorAll('[data-c]').forEach((b) => (b.onchange = guard(() => { b.checked ? picked.add(b.dataset.c) : picked.delete(b.dataset.c); return render(); })));
    const atEl = $('#at', root); if (atEl) atEl.onchange = guard(() => { at = atEl.value; return render(); });
  };
  await render();
}
async function tabPreview(app, body) { const rows = await api(`/campaigns?app_id=${app.id}`); await previewUI(body, { app, campaigns: rows }); }
async function campPreview(c, app, body) { body.innerHTML = '<div class="callout" style="margin-bottom:16px">This is how the app looks with this campaign on, whatever its dates.</div><div id="pvh"></div>'; await previewUI($('#pvh'), { app, fixed: c.id }); }

// ---------- analytics ----------
function analyticsBlock(a, { rejected = [] } = {}) {
  const kpi = (l, v) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`;
  const maxI = Math.max(1, ...a.by_placement.map((p) => p.impressions));
  return `<div class="grid g4" style="margin-bottom:16px">${kpi('Views', nf(a.impressions))}${kpi('Taps', nf(a.clicks))}${kpi('Tap rate', pct(a.ctr))}${kpi('Different phones', nf(a.devices))}</div>
    <div class="card" style="margin-bottom:16px"><div class="card-head"><h2>Day by day</h2></div>${chart(a.by_day)}</div>
    <div class="grid g2"><div class="card flush table-wrap"><table><thead><tr><th>Ad spot</th><th class="num">Views</th><th class="num">Taps</th><th class="num">Tap rate</th></tr></thead><tbody>${a.by_placement.map((p) => `<tr><td>${e(p.name)}<div class="bar-inline"><b style="width:${(p.impressions / maxI) * 100}%"></b></div></td><td class="num">${nf(p.impressions)}</td><td class="num">${nf(p.clicks)}</td><td class="num">${pct(p.ctr)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No data yet</td></tr>'}</tbody></table></div>
    <div class="card flush table-wrap"><table><thead><tr><th>Ad picture</th><th class="num">Views</th><th class="num">Tap rate</th></tr></thead><tbody>${a.by_creative.map((p) => `<tr><td><div class="row" style="flex-wrap:nowrap"><img class="thumb sm" style="width:56px;height:32px" src="${media(p.file)}" alt="">${e(p.name)}</div></td><td class="num">${nf(p.impressions)}</td><td class="num">${pct(p.ctr)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No data yet</td></tr>'}</tbody></table></div></div>
    <div class="callout" style="margin-top:16px"><strong>Why you can trust these numbers.</strong> Only ads that AdForge itself sent to the app can be counted. A view counts once the ad has been on screen for a full second, and once per phone every 30 minutes. Repeats, fakes and outdated reports are thrown out.${rejected.length ? ` Thrown out so far: ${rejected.map((r) => `${nf(r.n)} ${(REJECT_LABEL[r.reason] || r.reason).toLowerCase()}`).join(', ')}.` : ''}</div>`;
}
async function campAnalytics(c, body) { const a = await api(`/campaigns/${c.id}/analytics`); body.innerHTML = analyticsBlock(a, { rejected: a.rejected }); }
async function tabAppAnalytics(app, body) { const a = await api(`/apps/${app.id}/analytics`); body.innerHTML = analyticsBlock(a, { rejected: a.rejected }); }

// ---------- audit ----------
const ACTION = { 'campaign.create': 'Created a campaign', 'campaign.update': 'Edited a campaign', 'campaign.activate': 'Turned a campaign on', 'campaign.pause': 'Paused a campaign', 'campaign.expire': 'Ended a campaign',
  'campaign.scheduled': 'Campaign set to start later', 'campaign.active': 'Campaign went live', 'campaign.expired': 'Campaign ended (end date reached)', 'campaign.paused': 'Campaign paused', 'campaign.draft': 'Campaign set to not turned on', 'campaign.duplicate': 'Copied a campaign', 'campaign.delete': 'Deleted a campaign',
  'asset.replace_add': 'Swapped a picture', 'asset.replace_update': 'Changed a swapped picture', 'asset.replace_remove': 'Put the original picture back', 'asset.replace_all': 'Swapped every spot that fits',
  'creative.upload': 'Uploaded an ad image', 'creative.archive': 'Removed an ad image', 'app.ingest': 'TrendPilot added the app', 'user.login': 'Signed in' };
function detailText(d) {
  if (!d) return '';
  const parts = [];
  if (d.placement) parts.push(`${d.placement} → ${d.creative}`);
  if (d.name && !d.placement) parts.push(d.name);
  if (d.replaced !== undefined) parts.push(`${d.replaced} replaced${d.skipped ? `, ${d.skipped} skipped` : ''}`);
  if (d.from && d.to) parts.push(`${d.from} → ${d.to}${d.automatic ? ' (by its dates)' : ''}`);
  if (d.after) parts.push(`dates ${window_(d.after.start, d.after.end)}, priority ${d.after.priority}`);
  if (d.start || d.end) parts.push(window_(d.start, d.end));
  if (d.size) parts.push(d.size);
  return parts.join(' · ');
}
function auditTable(rows) {
  if (!rows.length) return '<div class="card empty">Nothing recorded yet.</div>';
  return `<div class="card flush table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="small nowrap">${dt(r.ts)}<div class="muted">${ago(r.ts)}</div></td><td>${e(r.actor)}<div class="small muted">${e(r.actor_role)}</div></td><td>${e(ACTION[r.action] || r.action)}${r.campaign_name ? `<div class="small"><a href="#/campaigns/${r.campaign_id}">${e(r.campaign_name)}</a></div>` : ''}</td><td class="small muted">${e(detailText(r.detail))}</td></tr>`).join('')}</tbody></table></div>`;
}
async function campActivity(c, body) { body.innerHTML = auditTable(await api(`/audit?campaign_id=${c.id}`)); }
async function auditPage() {
  const rows = await api('/audit?limit=200');
  shell('#/audit', `<div class="page-head"><div><h1>Activity log</h1><div class="sub">Who changed what and when, including changes AdForge made by itself because of start and end dates.</div></div></div>${auditTable(rows)}`);
}

// ---------- router ----------
async function route() {
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/').filter(Boolean);
  if (!state.token) { if (parts[0] !== 'login') location.hash = '#/login'; return loginPage(); }
  if (!state.user) {
    try { state.user = await api('/me'); } catch { return loginPage(); }
  }
  if (parts[0] === 'login') { location.hash = '#/'; return; }
  try {
    if (!parts.length) return await overviewPage();
    if (parts[0] === 'apps' && !parts[1]) return await appsPage();
    if (parts[0] === 'apps') return await appPage(parts[1], parts[2] || 'placements');
    if (parts[0] === 'campaigns' && !parts[1]) return await campaignsPage();
    if (parts[0] === 'campaigns') return await campaignPage(parts[1], parts[2]);
    if (parts[0] === 'audit') return await auditPage();
    location.hash = '#/';
  } catch (err) {
    shell('', `<div class="card empty"><h3>That didn't load</h3>${e(err.message)}<div style="margin-top:12px"><a href="#/">Back to overview</a></div></div>`);
  }
}
window.addEventListener('hashchange', route);
route();
