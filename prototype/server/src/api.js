const express = require('express');
const { db, tx } = require('./db');
const L = require('./lib');
const { HttpError, bad, uid, nowIso } = L;

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((r) => { if (r !== undefined && !res.headersSent) res.json(r); }).catch(next);

// ---------- auth ----------
router.post('/auth/login', wrap((req) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
  if (!u || !L.checkPassword(String(password || ''), u.pw_hash)) throw new HttpError(401, 'Wrong email or password');
  const token = L.sign({ u: u.id, exp: Date.now() + 12 * 3600e3 });
  L.audit(u, 'user.login', { entity: 'user', entity_id: u.id });
  return { token, user: publicUser(u) };
}));

function publicUser(u) {
  const adv = u.advertiser_id ? db.prepare('SELECT id, name, color FROM advertisers WHERE id = ?').get(u.advertiser_id) : null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, advertiser: adv };
}

// TrendPilot registers apps with its own key, not a user session.
router.post('/ingest/apps', wrap(async (req) => {
  if (req.get('x-trendpilot-key') !== (process.env.TRENDPILOT_KEY || 'trendpilot-dev-key')) throw new HttpError(401, 'Bad TrendPilot key');
  return ingestApp(req.body || {}, { name: 'TrendPilot', role: 'system' });
}));

router.use((req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  const t = m && L.unsign(m[1]);
  const u = t && t.exp > Date.now() && db.prepare('SELECT * FROM users WHERE id = ?').get(t.u);
  if (!u) return next(new HttpError(401, 'Please sign in'));
  req.user = u;
  next();
});
const isAdv = (req) => req.user.role === 'advertiser';
const adminOnly = (req) => { if (isAdv(req)) throw new HttpError(403, 'Administrators only'); };

router.get('/me', wrap((req) => publicUser(req.user)));
router.get('/advertisers', wrap((req) =>
  isAdv(req) ? db.prepare('SELECT * FROM advertisers WHERE id = ?').all(req.user.advertiser_id) : db.prepare('SELECT * FROM advertisers ORDER BY name').all()));

// ---------- apps & placements ----------
function appRow(id) {
  const a = db.prepare('SELECT id, slug, name, category, platform, version, source, created_at FROM apps WHERE id = ?').get(id);
  if (!a) throw new HttpError(404, 'App not found');
  return a;
}

router.get('/apps', wrap((req) => {
  const t = Date.now();
  return db.prepare('SELECT id, slug, name, category, platform, version, source, created_at FROM apps ORDER BY name').all().map((a) => {
    const placements = db.prepare('SELECT COUNT(*) n FROM placements WHERE app_id = ?').get(a.id).n;
    const live = winners(a.id, t).size;
    const campaigns = db.prepare('SELECT * FROM campaigns WHERE app_id = ?' + (isAdv(req) ? ' AND advertiser_id = ?' : '')).all(...[a.id, ...(isAdv(req) ? [req.user.advertiser_id] : [])]);
    const first = db.prepare('SELECT original_file FROM placements WHERE app_id = ? AND original_file IS NOT NULL ORDER BY rowid LIMIT 1').get(a.id);
    return { ...a, placements, live_placements: live, campaigns: campaigns.length,
      active_campaigns: campaigns.filter((c) => L.effective(c, t) === 'active').length, cover: first?.original_file || null };
  });
}));
const winners = (appId, t) => L.winners(appId, t);

function placementsFor(appId, t = Date.now(), only = null) {
  const win = L.winners(appId, t, only);
  return db.prepare('SELECT * FROM placements WHERE app_id = ? ORDER BY rowid').all(appId).map((p) => {
    const w = win.get(p.id);
    return { ...p, formats: p.formats.split(','),
      live: w ? { campaign_id: w.campaign_id, campaign_name: w.campaign_name, creative_id: w.creative_id, creative_name: w.creative_name,
        file: w.file, advertiser: w.advertiser, until: w.window.end ? new Date(w.window.end).toISOString() : null } : null };
  });
}

router.get('/apps/:id', wrap((req) => {
  const app = appRow(req.params.id);
  return { ...app,
    screens: db.prepare('SELECT * FROM screens WHERE app_id = ? ORDER BY ord').all(app.id),
    placements: placementsFor(app.id) };
}));

router.get('/apps/:id/sdk', wrap((req) => {
  adminOnly(req);
  appRow(req.params.id);
  return { sdk_key: db.prepare('SELECT sdk_key FROM apps WHERE id = ?').get(req.params.id).sdk_key };
}));

router.get('/placements/:id', wrap((req) => {
  const p = db.prepare('SELECT * FROM placements WHERE id = ?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Placement not found');
  const campaigns = db.prepare(`SELECT i.*, c.name campaign_name, c.state, c.start_at cs, c.end_at ce, c.advertiser_id, cr.name creative_name, cr.file
      FROM items i JOIN campaigns c ON c.id = i.campaign_id JOIN creatives cr ON cr.id = i.creative_id
      WHERE i.placement_id = ? ${isAdv(req) ? 'AND c.advertiser_id = ?' : ''}`).all(...[p.id, ...(isAdv(req) ? [req.user.advertiser_id] : [])]);
  const history = db.prepare(`SELECT h.*, c.name campaign_name, cr.name creative_name, cr.file FROM history h
      LEFT JOIN campaigns c ON c.id = h.campaign_id LEFT JOIN creatives cr ON cr.id = h.creative_id
      WHERE h.placement_id = ? ORDER BY h.id DESC LIMIT 100`).all(p.id);
  return { placement: { ...p, formats: p.formats.split(',') }, campaigns, history };
}));

router.get('/apps/:id/history', wrap((req) =>
  db.prepare(`SELECT h.*, p.name placement_name, c.name campaign_name, cr.name creative_name, cr.file FROM history h
      JOIN placements p ON p.id = h.placement_id LEFT JOIN campaigns c ON c.id = h.campaign_id LEFT JOIN creatives cr ON cr.id = h.creative_id
      WHERE h.app_id = ? ORDER BY h.id DESC LIMIT 200`).all(req.params.id)));

// Preview: what the app would look like with chosen campaigns forced on, or as of a moment in time.
router.get('/apps/:id/preview', wrap((req) => {
  const app = appRow(req.params.id);
  const only = req.query.campaigns ? String(req.query.campaigns).split(',').filter(Boolean) : null;
  const at = req.query.at ? Date.parse(req.query.at) : Date.now();
  if (Number.isNaN(at)) throw bad('Invalid "at" time');
  if (isAdv(req) && only) {
    const mine = db.prepare('SELECT id FROM campaigns WHERE advertiser_id = ?').all(req.user.advertiser_id).map((r) => r.id);
    if (only.some((id) => !mine.includes(id))) throw new HttpError(403, 'Not your campaign');
  }
  return { app: app.name, at: new Date(at).toISOString(), forced: !!only,
    screens: db.prepare('SELECT * FROM screens WHERE app_id = ? ORDER BY ord').all(app.id),
    placements: placementsFor(app.id, at, only) };
}));

// ---------- creatives ----------
router.get('/apps/:id/creatives', wrap((req) => {
  const rows = db.prepare(`SELECT cr.*, a.name advertiser FROM creatives cr JOIN advertisers a ON a.id = cr.advertiser_id
      WHERE cr.app_id = ? AND cr.archived = 0 ${isAdv(req) ? 'AND cr.advertiser_id = ?' : ''} ORDER BY cr.created_at DESC`)
    .all(...[req.params.id, ...(isAdv(req) ? [req.user.advertiser_id] : [])]);
  const placements = db.prepare('SELECT * FROM placements WHERE app_id = ?').all(req.params.id);
  return rows.map((cr) => ({ ...cr, fits: placements.filter((p) => L.eligibility(p, cr).ok).map((p) => p.id) }));
}));

router.post('/apps/:id/creatives', wrap(async (req) => {
  const app = appRow(req.params.id);
  const files = req.body?.files;
  if (!Array.isArray(files) || !files.length) throw bad('Send at least one image');
  if (files.length > 40) throw bad('Upload at most 40 images at a time');
  const advertiserId = isAdv(req) ? req.user.advertiser_id : req.body.advertiser_id;
  if (!db.prepare('SELECT 1 FROM advertisers WHERE id = ?').get(advertiserId)) throw bad('Choose an advertiser');
  const made = [], failed = [];
  for (const f of files) {
    try {
      const img = await L.ingestImage(Buffer.from(String(f.data || ''), 'base64'));
      const id = uid('cr');
      const name = String(f.name || 'Untitled').replace(/\.[a-z0-9]+$/i, '').slice(0, 80);
      db.prepare(`INSERT INTO creatives (id, app_id, advertiser_id, name, file, format, width, height, bytes, sha256, created_at, created_by)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, app.id, advertiserId, name, img.file, img.format, img.width, img.height, img.bytes, img.sha256, nowIso(), req.user.email);
      L.audit(req.user, 'creative.upload', { entity: 'creative', entity_id: id, app_id: app.id, detail: { name, size: `${img.width}×${img.height}` } });
      made.push(id);
    } catch (e) { failed.push({ name: f.name, error: e.message }); }
  }
  return { created: made, failed };
}));

router.delete('/creatives/:id', wrap((req) => {
  const cr = db.prepare('SELECT * FROM creatives WHERE id = ?').get(req.params.id);
  if (!cr) throw new HttpError(404, 'Creative not found');
  if (isAdv(req) && cr.advertiser_id !== req.user.advertiser_id) throw new HttpError(403, 'Not your creative');
  const used = db.prepare(`SELECT c.name FROM items i JOIN campaigns c ON c.id = i.campaign_id WHERE i.creative_id = ? AND c.state IN ('enabled','paused')`).all(cr.id);
  if (used.length) throw bad(`Still used by: ${used.map((u) => u.name).join(', ')}. Remove it from those campaigns first.`);
  db.prepare('UPDATE creatives SET archived = 1 WHERE id = ?').run(cr.id);
  L.audit(req.user, 'creative.archive', { entity: 'creative', entity_id: cr.id, app_id: cr.app_id, detail: { name: cr.name } });
  return { ok: true };
}));

// ---------- campaigns ----------
function loadCampaign(req, id) {
  const c = db.prepare(`SELECT c.*, a.name advertiser, a.color advertiser_color, ap.name app_name FROM campaigns c
      JOIN advertisers a ON a.id = c.advertiser_id JOIN apps ap ON ap.id = c.app_id WHERE c.id = ?`).get(id);
  if (!c) throw new HttpError(404, 'Campaign not found');
  if (isAdv(req) && c.advertiser_id !== req.user.advertiser_id) throw new HttpError(403, 'Not your campaign');
  return c;
}
const iso = (v, label) => {
  if (v === null || v === undefined || v === '') return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw bad(`${label} is not a valid date`);
  return new Date(ms).toISOString();
};
function checkRange(s, e, what) { if (s && e && Date.parse(e) <= Date.parse(s)) throw bad(`${what}: the end must be after the start`); }

function summarize(c, t = Date.now()) {
  const items = db.prepare('SELECT COUNT(*) n FROM items WHERE campaign_id = ?').get(c.id).n;
  const m = db.prepare(`SELECT SUM(type='impression') imp, SUM(type='click') clk FROM events WHERE campaign_id = ?`).get(c.id);
  return { ...c, status: L.effective(c, t), items, impressions: m.imp || 0, clicks: m.clk || 0 };
}

router.get('/campaigns', wrap((req) => {
  const where = [], args = [];
  if (req.query.app_id) { where.push('c.app_id = ?'); args.push(req.query.app_id); }
  if (isAdv(req)) { where.push('c.advertiser_id = ?'); args.push(req.user.advertiser_id); }
  const rows = db.prepare(`SELECT c.*, a.name advertiser, a.color advertiser_color, ap.name app_name FROM campaigns c
      JOIN advertisers a ON a.id = c.advertiser_id JOIN apps ap ON ap.id = c.app_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.created_at DESC`).all(...args);
  return rows.map((c) => summarize(c));
}));

router.post('/campaigns', wrap((req) => {
  const b = req.body || {};
  const app = appRow(b.app_id);
  const advertiserId = isAdv(req) ? req.user.advertiser_id : b.advertiser_id;
  if (!db.prepare('SELECT 1 FROM advertisers WHERE id = ?').get(advertiserId)) throw bad('Choose an advertiser');
  const name = String(b.name || '').trim();
  if (!name) throw bad('Give the campaign a name');
  const start = iso(b.start_at, 'Start'), end = iso(b.end_at, 'End');
  checkRange(start, end, 'Campaign dates');
  const priority = Math.min(10, Math.max(1, parseInt(b.priority ?? 5, 10) || 5));
  const id = uid('cmp');
  db.prepare(`INSERT INTO campaigns (id, app_id, advertiser_id, name, priority, state, start_at, end_at, last_effective, created_at, created_by)
              VALUES (?,?,?,?,?,'draft',?,?,'draft',?,?)`).run(id, app.id, advertiserId, name, priority, start, end, nowIso(), req.user.email);
  L.audit(req.user, 'campaign.create', { entity: 'campaign', entity_id: id, app_id: app.id, campaign_id: id, detail: { name } });
  return summarize(loadCampaign(req, id));
}));

router.get('/campaigns/:id', wrap((req) => {
  const c = loadCampaign(req, req.params.id);
  const t = Date.now();
  const win = L.winners(c.app_id, t);
  const items = db.prepare(`SELECT i.*, cr.name creative_name, cr.file, cr.width cw, cr.height ch, cr.format cformat,
        p.name placement_name, p.key placement_key, p.original_file, p.px_w, p.px_h, p.formats, p.location, p.screen_id
      FROM items i JOIN creatives cr ON cr.id = i.creative_id JOIN placements p ON p.id = i.placement_id
      WHERE i.campaign_id = ? ORDER BY p.rowid`).all(c.id).map((i) => {
    const w = L.window(c, i);
    let live = 'inactive';
    if (c.state === 'enabled' && i.enabled) live = w.start !== null && t < w.start ? 'scheduled' : w.end !== null && t >= w.end ? 'ended' : 'live';
    const serving = win.get(i.placement_id);
    return { ...i, formats: i.formats.split(','), status: live,
      winning: live === 'live' && serving?.item_id === i.id,
      outranked_by: live === 'live' && serving && serving.item_id !== i.id ? serving.campaign_name : null };
  });
  return { ...summarize(c, t), items };
}));

router.patch('/campaigns/:id', wrap((req) => {
  const c = loadCampaign(req, req.params.id);
  if (c.state === 'expired') throw bad('Expired campaigns can\'t be edited. Duplicate it instead.');
  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : c.name;
  if (!name) throw bad('Give the campaign a name');
  const start = b.start_at !== undefined ? iso(b.start_at, 'Start') : c.start_at;
  const end = b.end_at !== undefined ? iso(b.end_at, 'End') : c.end_at;
  checkRange(start, end, 'Campaign dates');
  const priority = b.priority !== undefined ? Math.min(10, Math.max(1, parseInt(b.priority, 10) || 5)) : c.priority;
  db.prepare('UPDATE campaigns SET name=?, start_at=?, end_at=?, priority=? WHERE id=?').run(name, start, end, priority, c.id);
  L.audit(req.user, 'campaign.update', { entity: 'campaign', entity_id: c.id, app_id: c.app_id, campaign_id: c.id,
    detail: { before: { name: c.name, start: c.start_at, end: c.end_at, priority: c.priority }, after: { name, start, end, priority } } });
  L.tick();
  return summarize(loadCampaign(req, c.id));
}));

router.post('/campaigns/:id/state', wrap((req) => {
  const c = loadCampaign(req, req.params.id);
  const action = req.body?.action;
  const next = { activate: 'enabled', pause: 'paused', expire: 'expired', draft: 'draft' }[action];
  if (!next) throw bad('Unknown action');
  if (c.state === 'expired') throw bad('This campaign has expired. Duplicate it to run it again.');
  if (action === 'pause' && c.state !== 'enabled') throw bad('Only a running or scheduled campaign can be paused');
  if (action === 'draft' && c.state === 'enabled') throw bad('Pause the campaign first');
  if (action === 'activate') {
    if (!db.prepare('SELECT 1 FROM items WHERE campaign_id = ?').get(c.id)) throw bad('Add at least one asset replacement before activating');
    if (c.end_at && Date.parse(c.end_at) <= Date.now()) throw bad('The end date has already passed. Change it first.');
  }
  db.prepare('UPDATE campaigns SET state = ? WHERE id = ?').run(next, c.id);
  L.audit(req.user, `campaign.${action}`, { entity: 'campaign', entity_id: c.id, app_id: c.app_id, campaign_id: c.id, detail: { from: c.state, to: next } });
  L.tick();
  return summarize(loadCampaign(req, c.id));
}));

router.post('/campaigns/:id/duplicate', wrap((req) => {
  const c = loadCampaign(req, req.params.id);
  const id = uid('cmp');
  tx(() => {
    db.prepare(`INSERT INTO campaigns (id, app_id, advertiser_id, name, priority, state, start_at, end_at, last_effective, created_at, created_by)
                VALUES (?,?,?,?,?,'draft',NULL,NULL,'draft',?,?)`).run(id, c.app_id, c.advertiser_id, `${c.name} (copy)`, c.priority, nowIso(), req.user.email);
    db.prepare(`INSERT INTO items (id, campaign_id, placement_id, creative_id, click_url, enabled)
                SELECT 'it_' || lower(hex(randomblob(5))), ?, placement_id, creative_id, click_url, enabled FROM items WHERE campaign_id = ?`).run(id, c.id);
  });
  L.audit(req.user, 'campaign.duplicate', { entity: 'campaign', entity_id: id, app_id: c.app_id, campaign_id: id, detail: { from: c.id } });
  return summarize(loadCampaign(req, id));
}));

router.delete('/campaigns/:id', wrap((req) => {
  const c = loadCampaign(req, req.params.id);
  if (c.state !== 'draft') throw bad('Only drafts can be deleted. Expire the campaign to retire it.');
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(c.id);
  L.audit(req.user, 'campaign.delete', { entity: 'campaign', entity_id: c.id, app_id: c.app_id, detail: { name: c.name } });
  return { ok: true };
}));

// ---------- campaign items (individual replacement) ----------
function validateClick(u) {
  if (!u) return null;
  let url;
  try { url = new URL(u); } catch { throw bad('The link must be a full web address, like https://example.com'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw bad('The link must start with http:// or https://');
  return url.toString();
}

function creativeFor(req, c, creativeId) {
  const cr = db.prepare('SELECT * FROM creatives WHERE id = ? AND archived = 0').get(creativeId);
  if (!cr || cr.app_id !== c.app_id) throw bad('That image isn\'t available for this app');
  if (cr.advertiser_id !== c.advertiser_id) throw bad('That image belongs to a different advertiser');
  return cr;
}

router.put('/campaigns/:id/items/:placementId', wrap((req) => {
  const c = loadCampaign(req, req.params.id);
  if (c.state === 'expired') throw bad('Expired campaigns can\'t be edited');
  const p = db.prepare('SELECT * FROM placements WHERE id = ? AND app_id = ?').get(req.params.placementId, c.app_id);
  if (!p) throw new HttpError(404, 'Placement not found in this app');
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM items WHERE campaign_id = ? AND placement_id = ?').get(c.id, p.id);
  const creativeId = b.creative_id ?? existing?.creative_id;
  const cr = creativeFor(req, c, creativeId);
  const el = L.eligibility(p, cr);
  if (!el.ok && !b.force) throw bad(`${cr.name} doesn't fit ${p.name}: ${el.reasons.join('; ')}`);
  const start = b.start_at !== undefined ? iso(b.start_at, 'Asset start') : existing?.start_at ?? null;
  const end = b.end_at !== undefined ? iso(b.end_at, 'Asset end') : existing?.end_at ?? null;
  checkRange(start, end, 'Asset dates');
  const click = b.click_url !== undefined ? validateClick(b.click_url) : existing?.click_url ?? null;
  const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : existing?.enabled ?? 1;
  if (existing) {
    db.prepare('UPDATE items SET creative_id=?, start_at=?, end_at=?, click_url=?, enabled=? WHERE id=?').run(cr.id, start, end, click, enabled, existing.id);
  } else {
    db.prepare('INSERT INTO items (id, campaign_id, placement_id, creative_id, start_at, end_at, click_url, enabled) VALUES (?,?,?,?,?,?,?,?)')
      .run(uid('it'), c.id, p.id, cr.id, start, end, click, enabled);
  }
  L.audit(req.user, existing ? 'asset.replace_update' : 'asset.replace_add', { entity: 'placement', entity_id: p.id, app_id: c.app_id, campaign_id: c.id,
    detail: { placement: p.name, creative: cr.name, start, end, enabled: !!enabled, before: existing ? existing.creative_id : null } });
  L.tick();
  return { ok: true };
}));

router.delete('/campaigns/:id/items/:placementId', wrap((req) => {
  const c = loadCampaign(req, req.params.id);
  if (c.state === 'expired') throw bad('Expired campaigns can\'t be edited');
  const r = db.prepare('DELETE FROM items WHERE campaign_id = ? AND placement_id = ?').run(c.id, req.params.placementId);
  if (!r.changes) throw new HttpError(404, 'That asset isn\'t part of this campaign');
  L.audit(req.user, 'asset.replace_remove', { entity: 'placement', entity_id: req.params.placementId, app_id: c.app_id, campaign_id: c.id });
  L.tick();
  return { ok: true };
}));

// Replace every eligible placement in one go. Each placement gets the best-fitting of the chosen creatives.
router.post('/campaigns/:id/replace-all', wrap((req) => {
  const c = loadCampaign(req, req.params.id);
  if (c.state === 'expired') throw bad('Expired campaigns can\'t be edited');
  const b = req.body || {};
  const ids = Array.isArray(b.creative_ids) && b.creative_ids.length ? b.creative_ids : null;
  const pool = (ids ? ids.map((id) => creativeFor(req, c, id))
    : db.prepare('SELECT * FROM creatives WHERE app_id = ? AND advertiser_id = ? AND archived = 0').all(c.app_id, c.advertiser_id));
  if (!pool.length) throw bad('Upload some images for this advertiser first');
  const click = validateClick(b.click_url);
  const only = Array.isArray(b.placement_ids) ? new Set(b.placement_ids) : null;
  const placements = db.prepare('SELECT * FROM placements WHERE app_id = ? ORDER BY rowid').all(c.app_id).filter((p) => !only || only.has(p.id));
  const done = [], skipped = [];
  tx(() => {
    for (const p of placements) {
      const fits = pool.map((cr) => ({ cr, el: L.eligibility(p, cr) })).filter((x) => x.el.ok).sort((a, z) => a.el.diff - z.el.diff);
      if (!fits.length) { skipped.push({ placement_id: p.id, name: p.name, reason: 'No chosen image has the right shape or format' }); continue; }
      const existing = db.prepare('SELECT * FROM items WHERE campaign_id = ? AND placement_id = ?').get(c.id, p.id);
      if (existing && b.keep_existing) { skipped.push({ placement_id: p.id, name: p.name, reason: 'Already has an image in this campaign' }); continue; }
      const best = fits[0].cr;
      if (existing) db.prepare('UPDATE items SET creative_id = ?, click_url = COALESCE(?, click_url), enabled = 1 WHERE id = ?').run(best.id, click, existing.id);
      else db.prepare('INSERT INTO items (id, campaign_id, placement_id, creative_id, click_url) VALUES (?,?,?,?,?)').run(uid('it'), c.id, p.id, best.id, click);
      done.push({ placement_id: p.id, name: p.name, creative: best.name });
    }
  });
  L.audit(req.user, 'asset.replace_all', { entity: 'campaign', entity_id: c.id, app_id: c.app_id, campaign_id: c.id,
    detail: { replaced: done.length, skipped: skipped.length, placements: done.map((d) => d.name) } });
  L.tick();
  return { replaced: done, skipped };
}));

// ---------- analytics ----------
function analytics(where, args, { from, to }) {
  const range = [];
  const a = [...args];
  if (from) { range.push('day >= ?'); a.push(from); }
  if (to) { range.push('day <= ?'); a.push(to); }
  const cond = [where, ...range].filter(Boolean).join(' AND ');
  const sum = db.prepare(`SELECT COALESCE(SUM(type='impression'),0) impressions, COALESCE(SUM(type='click'),0) clicks,
      COUNT(DISTINCT CASE WHEN type='impression' THEN device_id END) devices FROM events WHERE ${cond}`).get(...a);
  const byDay = db.prepare(`SELECT day, SUM(type='impression') impressions, SUM(type='click') clicks FROM events WHERE ${cond} GROUP BY day ORDER BY day`).all(...a);
  const byPlacement = db.prepare(`SELECT e.placement_id, p.name, SUM(e.type='impression') impressions, SUM(e.type='click') clicks
      FROM events e JOIN placements p ON p.id = e.placement_id WHERE ${cond.replace(/\b(day|app_id|campaign_id)\b/g, 'e.$1')} GROUP BY e.placement_id ORDER BY impressions DESC`).all(...a);
  const byCreative = db.prepare(`SELECT e.creative_id, cr.name, cr.file, SUM(e.type='impression') impressions, SUM(e.type='click') clicks
      FROM events e JOIN creatives cr ON cr.id = e.creative_id WHERE ${cond.replace(/\b(day|app_id|campaign_id)\b/g, 'e.$1')} GROUP BY e.creative_id ORDER BY impressions DESC`).all(...a);
  const ctr = (r) => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions : 0 });
  return { ...ctr(sum), by_day: byDay, by_placement: byPlacement.map(ctr), by_creative: byCreative.map(ctr) };
}

router.get('/campaigns/:id/analytics', wrap((req) => {
  const c = loadCampaign(req, req.params.id);
  const out = analytics('campaign_id = ?', [c.id], req.query);
  out.rejected = db.prepare('SELECT reason, COUNT(*) n FROM event_rejects WHERE campaign_id = ? GROUP BY reason').all(c.id);
  return out;
}));

router.get('/apps/:id/analytics', wrap((req) => {
  appRow(req.params.id);
  if (isAdv(req)) {
    const out = analytics('app_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE advertiser_id = ?)', [req.params.id, req.user.advertiser_id], req.query);
    out.rejected = [];
    return out;
  }
  const out = analytics('app_id = ?', [req.params.id], req.query);
  out.rejected = db.prepare('SELECT reason, COUNT(*) n FROM event_rejects WHERE app_id = ? GROUP BY reason').all(req.params.id);
  return out;
}));

router.get('/overview', wrap((req) => {
  const t = Date.now();
  const advScope = isAdv(req) ? ' WHERE advertiser_id = ?' : '';
  const advArgs = isAdv(req) ? [req.user.advertiser_id] : [];
  const campaigns = db.prepare('SELECT * FROM campaigns' + advScope).all(...advArgs);
  const counts = {};
  for (const c of campaigns) { const s = L.effective(c, t); counts[s] = (counts[s] || 0) + 1; }
  const evWhere = isAdv(req) ? 'campaign_id IN (SELECT id FROM campaigns WHERE advertiser_id = ?)' : '1=1';
  const last = new Date(t - 13 * 86400e3).toISOString().slice(0, 10);
  const a = analytics(evWhere, advArgs, { from: last });
  const upcoming = campaigns.filter((c) => L.effective(c, t) === 'scheduled' || (L.effective(c, t) === 'active' && c.end_at))
    .map((c) => ({ id: c.id, name: c.name, status: L.effective(c, t), start_at: c.start_at, end_at: c.end_at }))
    .sort((x, y) => Date.parse(x.start_at && L.effective(x, t) === 'scheduled' ? x.start_at : x.end_at) - Date.parse(y.start_at && y.status === 'scheduled' ? y.start_at : y.end_at)).slice(0, 6);
  return { apps: db.prepare('SELECT COUNT(*) n FROM apps').get().n, campaigns: counts, last14: a, upcoming,
    rejected: isAdv(req) ? [] : db.prepare('SELECT reason, COUNT(*) n FROM event_rejects GROUP BY reason').all() };
}));

// ---------- audit ----------
router.get('/audit', wrap((req) => {
  const where = [], args = [];
  if (req.query.campaign_id) { loadCampaign(req, req.query.campaign_id); where.push('campaign_id = ?'); args.push(req.query.campaign_id); }
  else if (isAdv(req)) { where.push('campaign_id IN (SELECT id FROM campaigns WHERE advertiser_id = ?)'); args.push(req.user.advertiser_id); }
  if (req.query.app_id) { where.push('app_id = ?'); args.push(req.query.app_id); }
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
  return db.prepare(`SELECT au.*, c.name campaign_name, ap.name app_name FROM audit au LEFT JOIN campaigns c ON c.id = au.campaign_id
      LEFT JOIN apps ap ON ap.id = au.app_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY au.id DESC LIMIT ${limit}`).all(...args)
    .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}));

// ---------- TrendPilot ingest ----------
async function ingestApp(b, actor) {
  const slug = String(b.slug || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) throw bad('slug must be lowercase letters, numbers and dashes');
  if (!b.name) throw bad('name is required');
  if (!Array.isArray(b.placements) || !b.placements.length) throw bad('placements is required');
  const crypto = require('crypto');
  const img = async (v) => (v ? L.ingestImage(Buffer.from(v, 'base64')) : null);
  const prepared = [];
  for (const s of b.screens || []) prepared.push({ s, img: await img(s.image_base64) });
  const pprep = [];
  for (const p of b.placements) pprep.push({ p, img: await img(p.original_base64) });
  return tx(() => {
    let app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug);
    if (!app) {
      const id = uid('app');
      db.prepare(`INSERT INTO apps (id, slug, name, category, platform, version, source, sdk_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, slug, b.name, b.category || null, 'flutter', b.version || null, 'TrendPilot', 'afk_' + crypto.randomBytes(18).toString('hex'), nowIso());
      app = db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
    } else {
      db.prepare('UPDATE apps SET name = ?, category = ?, version = ? WHERE id = ?').run(b.name, b.category || app.category, b.version || app.version, app.id);
    }
    const screenIds = {};
    prepared.forEach(({ s, img: im }, ord) => {
      const ex = db.prepare('SELECT id FROM screens WHERE app_id = ? AND key = ?').get(app.id, s.key);
      const id = ex?.id || uid('scr');
      if (ex) db.prepare('UPDATE screens SET name = ?, image_file = COALESCE(?, image_file), ord = ? WHERE id = ?').run(s.name || s.key, im?.file || null, ord, id);
      else db.prepare('INSERT INTO screens (id, app_id, key, name, image_file, ord) VALUES (?,?,?,?,?,?)').run(id, app.id, s.key, s.name || s.key, im?.file || null, ord);
      screenIds[s.key] = id;
    });
    for (const { p, img: im } of pprep) {
      if (!p.key || !p.px_w || !p.px_h) throw bad('each placement needs key, px_w and px_h');
      const ex = db.prepare('SELECT id FROM placements WHERE app_id = ? AND key = ?').get(app.id, p.key);
      const id = ex?.id || uid('pl');
      const vals = [screenIds[p.screen] || null, p.name || p.key, p.kind || 'image', p.location || null, im?.file || null,
        p.match_image ? String(p.match_image).toLowerCase() : null, p.integration === 'widget' ? 'widget' : 'asset',
        p.x ?? null, p.y ?? null, p.w ?? null, p.h ?? null, p.px_w, p.px_h,
        (p.formats || ['png', 'jpg', 'webp']).join(','), p.fit === 'contain' ? 'contain' : 'cover'];
      if (ex) db.prepare(`UPDATE placements SET screen_id=?, name=?, kind=?, location=?, original_file=COALESCE(?, original_file), match_image=?, integration=?,
          x=?, y=?, w=?, h=?, px_w=?, px_h=?, formats=?, fit=? WHERE id=?`).run(...vals, id);
      else db.prepare(`INSERT INTO placements (screen_id, name, kind, location, original_file, match_image, integration, x, y, w, h, px_w, px_h, formats, fit, id, app_id, key)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, id, app.id, p.key);
    }
    L.audit(actor, 'app.ingest', { entity: 'app', entity_id: app.id, app_id: app.id, detail: { slug, placements: b.placements.length } });
    return { id: app.id, slug, sdk_key: app.sdk_key };
  });
}

router.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

module.exports = { router, ingestApp };
