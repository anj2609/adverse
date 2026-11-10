const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { db, UPLOAD_DIR, DATA_DIR } = require('./db');

const uid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const nowIso = () => new Date().toISOString();
const dayOf = (iso) => iso.slice(0, 10);

function loadSecret() {
  if (process.env.ADFORGE_SECRET) return process.env.ADFORGE_SECRET;
  const f = path.join(DATA_DIR, 'secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8');
}
const SECRET = loadSecret();

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function unsign(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest();
  let got;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

// ---------- audit ----------
function audit(actor, action, f = {}) {
  db.prepare(`INSERT INTO audit (ts, actor, actor_role, action, entity, entity_id, app_id, campaign_id, detail)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(nowIso(), actor?.name || actor?.email || 'system', actor?.role || 'system', action,
      f.entity || null, f.entity_id || null, f.app_id || null, f.campaign_id || null,
      f.detail ? JSON.stringify(f.detail) : null);
}

// ---------- campaign status ----------
// Stored state is the operator's intent; the effective status also depends on the clock.
function effective(c, t = Date.now()) {
  if (c.state !== 'enabled') return c.state;
  if (c.start_at && t < Date.parse(c.start_at)) return 'scheduled';
  if (c.end_at && t >= Date.parse(c.end_at)) return 'expired';
  return 'active';
}

function window(c, i) {
  const s = [c.start_at, i.start_at].filter(Boolean).map(Date.parse);
  const e = [c.end_at, i.end_at].filter(Boolean).map(Date.parse);
  return { start: s.length ? Math.max(...s) : null, end: e.length ? Math.min(...e) : null };
}

// Items that would be live at time t. `only` forces a set of campaigns regardless of state/schedule (preview).
function liveItems(appId, t = Date.now(), only = null) {
  const rows = db.prepare(`
    SELECT i.id AS item_id, i.placement_id, i.creative_id, i.click_url, i.start_at AS i_start, i.end_at AS i_end,
           c.id AS campaign_id, c.name AS campaign_name, c.priority, c.state, c.start_at AS c_start, c.end_at AS c_end,
           cr.file, cr.width, cr.height, cr.format, cr.name AS creative_name, cr.sha256, a.name AS advertiser
    FROM items i JOIN campaigns c ON c.id = i.campaign_id
    JOIN creatives cr ON cr.id = i.creative_id
    JOIN advertisers a ON a.id = c.advertiser_id
    WHERE c.app_id = ? AND i.enabled = 1 AND cr.archived = 0`).all(appId);
  const out = [];
  for (const r of rows) {
    const c = { start_at: r.c_start, end_at: r.c_end };
    const w = window(c, { start_at: r.i_start, end_at: r.i_end });
    r.window = w;
    if (only) { if (only.includes(r.campaign_id)) out.push(r); continue; }
    if (r.state !== 'enabled') continue;
    if (w.start !== null && t < w.start) continue;
    if (w.end !== null && t >= w.end) continue;
    out.push(r);
  }
  return out;
}

// One winner per placement: higher priority first, then the most recently started campaign.
function winners(appId, t = Date.now(), only = null) {
  const best = new Map();
  for (const r of liveItems(appId, t, only)) {
    const cur = best.get(r.placement_id);
    const rank = (x) => [x.priority, x.window.start ?? 0];
    const better = !cur || rank(r)[0] > rank(cur)[0] || (rank(r)[0] === rank(cur)[0] && rank(r)[1] > rank(cur)[1]);
    if (better) best.set(r.placement_id, r);
  }
  return best;
}

// Next moment a window opens/closes, so SDKs know when their cache goes stale.
function nextBoundary(appId, t = Date.now()) {
  let next = Infinity;
  for (const r of db.prepare(`SELECT c.state, c.start_at cs, c.end_at ce, i.start_at s, i.end_at e FROM items i
        JOIN campaigns c ON c.id = i.campaign_id WHERE c.app_id = ? AND c.state = 'enabled' AND i.enabled = 1`).all(appId)) {
    for (const v of [r.cs, r.ce, r.s, r.e]) { const ms = v && Date.parse(v); if (ms && ms > t && ms < next) next = ms; }
  }
  return next === Infinity ? null : next;
}

// ---------- state reconciliation: audit status flips and placement history ----------
function tick(t = Date.now()) {
  const iso = new Date(t).toISOString();
  for (const c of db.prepare('SELECT * FROM campaigns').all()) {
    const eff = effective(c, t);
    if (c.last_effective !== eff) {
      if (c.last_effective !== null) {
        audit(null, `campaign.${eff}`, { entity: 'campaign', entity_id: c.id, app_id: c.app_id, campaign_id: c.id,
          detail: { from: c.last_effective, to: eff, automatic: c.state === 'enabled' } });
      }
      db.prepare('UPDATE campaigns SET last_effective = ? WHERE id = ?').run(eff, c.id);
    }
  }
  for (const app of db.prepare('SELECT id FROM apps').all()) {
    const win = winners(app.id, t);
    for (const p of db.prepare('SELECT id, name FROM placements WHERE app_id = ?').all(app.id)) {
      const last = db.prepare('SELECT * FROM history WHERE placement_id = ? ORDER BY id DESC LIMIT 1').get(p.id);
      const w = win.get(p.id);
      if (w) {
        if (!last || last.change !== 'live' || last.campaign_id !== w.campaign_id || last.creative_id !== w.creative_id) {
          db.prepare(`INSERT INTO history (ts, app_id, placement_id, campaign_id, creative_id, change, note) VALUES (?,?,?,?,?,?,?)`)
            .run(iso, app.id, p.id, w.campaign_id, w.creative_id, 'live', `${w.creative_name} went live (${w.campaign_name})`);
        }
      } else if (last && last.change === 'live') {
        db.prepare(`INSERT INTO history (ts, app_id, placement_id, campaign_id, creative_id, change, note) VALUES (?,?,?,?,?,?,?)`)
          .run(iso, app.id, p.id, null, null, 'original', 'Reverted to the original asset');
      }
    }
  }
}

// ---------- images ----------
const FORMAT_BY_SHARP = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };
async function ingestImage(buffer, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (buffer.length > maxBytes) throw bad(`Image is larger than ${Math.round(maxBytes / 1048576)} MB`);
  let meta;
  try { meta = await sharp(buffer).metadata(); } catch { throw bad('That file is not a readable image'); }
  const format = FORMAT_BY_SHARP[meta.format];
  if (!format) throw bad(`Unsupported image type "${meta.format}". Use PNG, JPG or WebP.`);
  if (!meta.width || !meta.height) throw bad('Image has no dimensions');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const file = `${sha256.slice(0, 24)}.${format}`;
  const full = path.join(UPLOAD_DIR, file);
  if (!fs.existsSync(full)) fs.writeFileSync(full, buffer);
  return { file, format, width: meta.width, height: meta.height, bytes: buffer.length, sha256 };
}

// Can this creative stand in for this placement without being distorted?
function eligibility(p, cr) {
  const reasons = [];
  if (!p.formats.split(',').includes(cr.format)) reasons.push(`format ${cr.format.toUpperCase()} not supported (needs ${p.formats.toUpperCase().replace(/,/g, '/')})`);
  const want = p.px_w / p.px_h, got = cr.width / cr.height;
  const diff = Math.abs(got - want) / want;
  if (diff > 0.12) reasons.push(`shape ${cr.width}×${cr.height} doesn't fit ${p.px_w}×${p.px_h}`);
  if (cr.width < p.px_w * 0.5) reasons.push(`too small (needs at least ${Math.round(p.px_w / 2)}px wide)`);
  return { ok: reasons.length === 0, reasons, diff };
}

module.exports = {
  uid, nowIso, dayOf, sign, unsign, hashPassword, checkPassword, HttpError, bad,
  audit, effective, window, liveItems, winners, nextBoundary, tick, ingestImage, eligibility,
};
