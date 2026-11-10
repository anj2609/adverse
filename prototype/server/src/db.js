const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.ADFORGE_DATA || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.ADFORGE_DB || path.join(DATA_DIR, 'adforge.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS advertisers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#4f46e5'
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','advertiser')),
  advertiser_id TEXT REFERENCES advertisers(id), pw_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT,
  platform TEXT NOT NULL DEFAULT 'flutter', version TEXT, source TEXT NOT NULL DEFAULT 'TrendPilot',
  sdk_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key TEXT NOT NULL, name TEXT NOT NULL, image_file TEXT, ord INTEGER NOT NULL DEFAULT 0,
  UNIQUE (app_id, key)
);
CREATE TABLE IF NOT EXISTS placements (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  screen_id TEXT REFERENCES screens(id) ON DELETE SET NULL,
  key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'image',
  location TEXT, original_file TEXT, match_image TEXT,
  integration TEXT NOT NULL DEFAULT 'asset' CHECK (integration IN ('asset','widget')),
  x REAL, y REAL, w REAL, h REAL,
  px_w INTEGER NOT NULL, px_h INTEGER NOT NULL,
  formats TEXT NOT NULL DEFAULT 'png,jpg,webp', fit TEXT NOT NULL DEFAULT 'cover',
  UNIQUE (app_id, key)
);
CREATE TABLE IF NOT EXISTS creatives (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  advertiser_id TEXT NOT NULL REFERENCES advertisers(id),
  name TEXT NOT NULL, file TEXT NOT NULL, format TEXT NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, created_by TEXT
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  advertiser_id TEXT NOT NULL REFERENCES advertisers(id),
  name TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 5,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','enabled','paused','expired')),
  start_at TEXT, end_at TEXT, last_effective TEXT,
  created_at TEXT NOT NULL, created_by TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  creative_id TEXT NOT NULL REFERENCES creatives(id),
  start_at TEXT, end_at TEXT, click_url TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, placement_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL,
  app_id TEXT NOT NULL, campaign_id TEXT NOT NULL, placement_id TEXT NOT NULL, creative_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('impression','click')),
  device_id TEXT NOT NULL, nonce TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS events_campaign ON events (campaign_id, day);
CREATE INDEX IF NOT EXISTS events_app ON events (app_id, day);
CREATE TABLE IF NOT EXISTS event_rejects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, app_id TEXT, campaign_id TEXT, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, actor_role TEXT,
  action TEXT NOT NULL, entity TEXT, entity_id TEXT, app_id TEXT, campaign_id TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_campaign ON audit (campaign_id);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, app_id TEXT NOT NULL,
  placement_id TEXT NOT NULL, campaign_id TEXT, creative_id TEXT,
  change TEXT NOT NULL CHECK (change IN ('live','original')), note TEXT
);
CREATE INDEX IF NOT EXISTS history_placement ON history (placement_id, id);
`);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, tx, DATA_DIR, UPLOAD_DIR };
