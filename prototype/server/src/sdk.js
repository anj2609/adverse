// Public endpoints used by the Flutter SDK inside published apps.
const express = require('express');
const crypto = require('crypto');
const { db } = require('./db');
const L = require('./lib');

const router = express.Router();
const TOKEN_TTL_MS = 7 * 86400e3;
const MIN_VIEW_MS = 1000;       // an impression only counts once the ad has been visible this long
const DEDUPE_WINDOW_MS = 30 * 60e3;
const MAX_BATCH = 200;

const publicBase = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

function appFromKey(req) {
  const key = req.get('x-adforge-key') || req.query.key;
  const app = key && db.prepare('SELECT * FROM apps WHERE sdk_key = ?').get(String(key));
  if (!app) { const e = new L.HttpError(401, 'Unknown app key'); throw e; }
  return app;
}

router.use((req, res, next) => { res.set('access-control-allow-origin', '*'); res.set('access-control-allow-headers', 'x-adforge-key, content-type, if-none-match'); next(); });
router.options('*', (req, res) => res.sendStatus(204));

// What should this app show right now? One entry per placement that has a campaign asset live.
router.get('/manifest', (req, res, next) => {
  try {
    const app = appFromKey(req);
    const t = Date.now();
    const base = publicBase(req);
    const win = L.winners(app.id, t);
    const placements = db.prepare('SELECT * FROM placements WHERE app_id = ? ORDER BY rowid').all(app.id).map((p) => {
      const w = win.get(p.id);
      const base_ = { key: p.key, match_image: p.match_image, integration: p.integration, fit: p.fit, width: p.px_w, height: p.px_h };
      if (!w) return { ...base_, creative: null };
      const nonce = crypto.randomBytes(8).toString('hex');
      const token = L.sign({ a: app.id, p: p.id, c: w.campaign_id, cr: w.creative_id, n: nonce, exp: t + TOKEN_TTL_MS });
      return { ...base_,
        creative: { id: w.creative_id, url: `${base}/media/${w.file}`, sha256: w.sha256, width: w.width, height: w.height, format: w.format },
        campaign_id: w.campaign_id, advertiser: w.advertiser,
        click_url: w.click_url ? `${base}/sdk/v1/click?t=${encodeURIComponent(token)}` : null,
        valid_until: w.window.end ? new Date(w.window.end).toISOString() : null,
        token };
    });
    const next_ = L.nextBoundary(app.id, t);
    const refresh = Math.max(15, Math.min(900, next_ ? Math.ceil((next_ - t) / 1000) + 1 : 900));
    // Tokens are unique per response, so the ETag hashes the visible content only.
    const etag = '"' + crypto.createHash('sha1').update(JSON.stringify(placements.map((p) => [p.key, p.creative?.id, p.campaign_id, p.valid_until]))).digest('hex').slice(0, 16) + '"';
    res.set('cache-control', 'no-cache');
    res.set('etag', etag);
    if (req.get('if-none-match') === etag) return res.sendStatus(304);
    res.json({ app: app.slug, generated_at: new Date(t).toISOString(), refresh_after_sec: refresh, placements });
  } catch (e) { next(e); }
});

function reject(appId, campaignId, reason) {
  db.prepare('INSERT INTO event_rejects (ts, app_id, campaign_id, reason) VALUES (?,?,?,?)').run(L.nowIso(), appId, campaignId, reason);
  return reason;
}

// Verifies the signed token a manifest handed out, then records the event once.
function record(app, ev, receivedAt) {
  const tok = L.unsign(ev?.token);
  if (!tok) return reject(app.id, null, 'bad_token');
  if (tok.a !== app.id) return reject(app.id, tok.c, 'wrong_app');
  if (tok.exp < receivedAt) return reject(app.id, tok.c, 'token_expired');
  if (ev.type !== 'impression' && ev.type !== 'click') return reject(app.id, tok.c, 'bad_type');
  const device = String(ev.device_id || '').slice(0, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(device)) return reject(app.id, tok.c, 'bad_device');
  if (ev.type === 'impression' && !(Number(ev.viewable_ms) >= MIN_VIEW_MS)) return reject(app.id, tok.c, 'not_viewable');
  const live = db.prepare(`SELECT 1 FROM items i JOIN campaigns c ON c.id = i.campaign_id
      WHERE i.campaign_id = ? AND i.placement_id = ? AND i.creative_id = ?`).get(tok.c, tok.p, tok.cr);
  if (!live) return reject(app.id, tok.c, 'unknown_campaign');
  // One impression per token+device per 30 minutes; clicks dedupe per minute so double taps don't count twice.
  const window_ = ev.type === 'click' ? 60e3 : DEDUPE_WINDOW_MS;
  const key = crypto.createHash('sha1').update(`${tok.n}|${ev.type}|${device}|${Math.floor(receivedAt / window_)}`).digest('hex');
  const ts = new Date(receivedAt).toISOString();
  const r = db.prepare(`INSERT OR IGNORE INTO events (ts, day, app_id, campaign_id, placement_id, creative_id, type, device_id, nonce, dedupe)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ts, L.dayOf(ts), app.id, tok.c, tok.p, tok.cr, ev.type, device, tok.n, key);
  return r.changes ? 'ok' : reject(app.id, tok.c, 'duplicate');
}

router.post('/events', express.json({ limit: '256kb' }), (req, res, next) => {
  try {
    const app = appFromKey(req);
    const events = Array.isArray(req.body?.events) ? req.body.events : null;
    if (!events) throw L.bad('events must be a list');
    if (events.length > MAX_BATCH) throw L.bad(`Send at most ${MAX_BATCH} events per request`);
    const t = Date.now();
    const result = { accepted: 0, rejected: {} };
    for (const ev of events) {
      const out = record(app, ev, t);
      if (out === 'ok') result.accepted++; else result.rejected[out] = (result.rejected[out] || 0) + 1;
    }
    res.json(result);
  } catch (e) { next(e); }
});

// Clicks go through us so they're counted before the person lands on the advertiser's page.
router.get('/click', (req, res, next) => {
  try {
    const tok = L.unsign(req.query.t);
    if (!tok) return res.status(400).send('Invalid link');
    const item = db.prepare('SELECT click_url FROM items WHERE campaign_id = ? AND placement_id = ? AND creative_id = ?').get(tok.c, tok.p, tok.cr);
    if (!item?.click_url) return res.status(404).send('Link no longer available');
    const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(tok.a);
    const device = String(req.query.d || '').slice(0, 64);
    if (app && /^[A-Za-z0-9_-]{8,64}$/.test(device)) record(app, { token: req.query.t, type: 'click', device_id: device }, Date.now());
    res.redirect(302, item.click_url);
  } catch (e) { next(e); }
});

router.use((err, req, res, next) => {
  if (err instanceof L.HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

module.exports = { router };
