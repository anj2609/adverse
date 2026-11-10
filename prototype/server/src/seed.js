// Demo data: four TrendPilot apps, four advertisers, and campaigns in every state.
const crypto = require('crypto');
const sharp = require('sharp');
const { db, tx } = require('./db');
const L = require('./lib');

const DAY = 86400e3;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const png = (svg) => sharp(Buffer.from(svg)).png().toBuffer();

const ADVERTISERS = [
  { key: 'aqua', name: 'AquaPure', color: '#0ea5e9', tag: 'Stay hydrated, stay sharp', cta: 'Drink better' },
  { key: 'brew', name: 'BrewCo', color: '#b45309', tag: 'Your morning, focused', cta: 'Try Morning Blend' },
  { key: 'sprint', name: 'SprintFit', color: '#16a34a', tag: 'Move more between tasks', cta: 'Start free week' },
  { key: 'luma', name: 'LumaBank', color: '#7c3aed', tag: 'Save without thinking', cta: 'Open an account' },
];

function original(label, w, h, hue) {
  return png(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue},18%,90%)"/><stop offset="1" stop-color="hsl(${hue},18%,78%)"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/><rect x="${w * 0.04}" y="${h * 0.06}" width="${w * 0.92}" height="${h * 0.88}" rx="${Math.min(w, h) * 0.06}" fill="none" stroke="hsl(${hue},12%,55%)" stroke-width="${Math.max(2, w / 180)}" stroke-dasharray="${w / 30} ${w / 60}"/>
    <text x="50%" y="${h * 0.48}" font-family="Helvetica,Arial,sans-serif" font-size="${Math.min(w, h) * 0.13}" font-weight="700" fill="hsl(${hue},15%,32%)" text-anchor="middle">Original asset</text>
    <text x="50%" y="${h * 0.48 + Math.min(w, h) * 0.13}" font-family="Helvetica,Arial,sans-serif" font-size="${Math.min(w, h) * 0.085}" fill="hsl(${hue},12%,42%)" text-anchor="middle">${esc(label)}</text></svg>`);
}

function creative(adv, w, h) {
  const big = Math.min(w, h * 2.4);
  const tall = h > w;
  return png(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${adv.color}"/><stop offset="1" stop-color="#0b1020"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w * 0.88}" cy="${h * (tall ? 0.22 : 0.2)}" r="${Math.min(w, h) * 0.38}" fill="#fff" opacity=".10"/>
    <circle cx="${w * 0.1}" cy="${h * 0.95}" r="${Math.min(w, h) * 0.3}" fill="#fff" opacity=".07"/>
    <text x="${w * 0.07}" y="${tall ? h * 0.42 : h * 0.43}" font-family="Helvetica,Arial,sans-serif" font-size="${tall ? w * 0.17 : big * 0.14}" font-weight="800" fill="#fff">${esc(adv.name)}</text>
    <text x="${w * 0.07}" y="${tall ? h * 0.48 : h * 0.62}" font-family="Helvetica,Arial,sans-serif" font-size="${tall ? w * 0.06 : big * 0.052}" fill="#fff" opacity=".88">${esc(adv.tag)}</text>
    ${h / w < 0.9 && w / h < 5 ? `<rect x="${w * 0.07}" y="${h * 0.72}" rx="${h * 0.07}" width="${Math.min(w * 0.36, h * 1.5)}" height="${h * 0.15}" fill="#fff"/>
    <text x="${w * 0.07 + Math.min(w * 0.36, h * 1.5) / 2}" y="${h * 0.72 + h * 0.105}" font-family="Helvetica,Arial,sans-serif" font-size="${h * 0.075}" font-weight="700" fill="${adv.color}" text-anchor="middle">${esc(adv.cta)}</text>` : ''}
    <text x="${w - w * 0.03}" y="${h - h * 0.04}" font-family="Helvetica,Arial,sans-serif" font-size="${Math.max(10, Math.min(w, h) * 0.05)}" fill="#fff" opacity=".75" text-anchor="end">Sponsored</text></svg>`);
}

function screenArt(title, accent, blocks) {
  const W = 360, H = 720;
  return png(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="30" fill="#0f172a" opacity=".85"/><text x="16" y="20" font-family="Helvetica,Arial" font-size="12" fill="#fff">9:41</text>
    <rect y="30" width="${W}" height="48" fill="#fff" opacity=".92"/><text x="16" y="60" font-family="Helvetica,Arial" font-size="17" font-weight="700" fill="#111827">${esc(title)}</text>
    ${blocks.map((b) => `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" rx="10" fill="#fff" opacity=".93"/>
    <rect x="${b[0] + 12}" y="${b[1] + 14}" width="${b[2] * 0.5}" height="9" rx="4" fill="${accent}" opacity=".85"/>
    <rect x="${b[0] + 12}" y="${b[1] + 32}" width="${b[2] * 0.75}" height="7" rx="3" fill="#cbd5e1"/>`).join('')}
    <rect y="${H - 62}" width="${W}" height="62" fill="#fff" opacity=".95"/>
    ${[0, 1, 2, 3].map((i) => `<circle cx="${45 + i * 90}" cy="${H - 34}" r="11" fill="${i === 0 ? accent : '#cbd5e1'}"/>`).join('')}</svg>`);
}

// Placement geometry on a 360×720 screen, in percent. Banners span the width, squares are 25% wide.
const SHAPES = {
  banner: { px_w: 720, px_h: 200, w: 100, h: (360 / 3.6 / 720) * 100 },
  hero: { px_w: 720, px_h: 400, w: 100, h: (360 / 1.8 / 720) * 100 },
  square: { px_w: 256, px_h: 256, w: 25, h: (90 / 720) * 100 },
  background: { px_w: 720, px_h: 1280, w: 100, h: 100 },
};

const APPS = [
  { slug: 'focus-planner', name: 'Focus Planner', category: 'Productivity', version: '1.4.2', hue: 215, accent: '#4f46e5', screens: [
      { key: 'home', name: 'Home', blocks: [[16, 380, 328, 70], [16, 464, 328, 70], [16, 548, 328, 70]] },
      { key: 'timer', name: 'Focus timer', blocks: [[16, 440, 328, 90]] } ],
    placements: [
      { key: 'home_banner', name: 'Home banner', shape: 'banner', screen: 'home', y: 12, kind: 'banner', location: 'Top of the Home screen, under the title bar', match_image: 'home_banner.png' },
      { key: 'focus_hero', name: 'Focus hero image', shape: 'hero', screen: 'home', y: 27, kind: 'hero', location: 'Home screen, large card above today’s tasks', match_image: 'focus_hero.png' },
      { key: 'timer_bg', name: 'Timer background', shape: 'background', screen: 'timer', y: 0, kind: 'background', location: 'Full-screen backdrop behind the focus timer', match_image: 'timer_bg.png' },
      { key: 'pomodoro_icon', name: 'Pomodoro mascot', shape: 'square', screen: 'timer', y: 16, x: 37.5, kind: 'icon', location: 'Centre of the timer screen, above the countdown', match_image: 'pomodoro.png' } ] },
  { slug: 'sip-water-tracker', name: 'Sip Water Tracker', category: 'Health', version: '2.0.1', hue: 195, accent: '#0284c7', screens: [
      { key: 'home', name: 'Today', blocks: [[16, 400, 328, 80], [16, 494, 328, 80]] },
      { key: 'stats', name: 'Weekly stats', blocks: [[16, 330, 328, 120], [16, 464, 328, 80]] } ],
    placements: [
      { key: 'bottle', name: 'Water bottle', shape: 'square', screen: 'home', y: 15, x: 37.5, kind: 'icon', location: 'Centre of the Today screen: the bottle that fills as you drink', match_image: 'bottle.png' },
      { key: 'today_banner', name: 'Today banner', shape: 'banner', screen: 'home', y: 12 + 25, kind: 'banner', location: 'Today screen, below the bottle', match_image: 'today_banner.png' },
      { key: 'stats_hero', name: 'Stats header', shape: 'hero', screen: 'stats', y: 12, kind: 'hero', location: 'Top of the Weekly stats screen', match_image: 'stats_hero.png' } ] },
  { slug: 'candy-match', name: 'Candy Match', category: 'Game', version: '3.2.0', hue: 330, accent: '#db2777', screens: [
      { key: 'menu', name: 'Main menu', blocks: [[60, 400, 240, 56], [60, 470, 240, 56]] },
      { key: 'level', name: 'Level', blocks: [[16, 380, 328, 200]] } ],
    placements: [
      { key: 'menu_bg', name: 'Menu background', shape: 'background', screen: 'menu', y: 0, kind: 'background', location: 'Full-screen backdrop on the main menu', match_image: 'backgroundd3.png' },
      { key: 'level_banner', name: 'Level banner', shape: 'banner', screen: 'level', y: 12, kind: 'banner', location: 'Top of every level, above the board', match_image: 'level_banner.png' },
      { key: 'reward_icon', name: 'Reward chest', shape: 'square', screen: 'level', y: 70, x: 37.5, kind: 'icon', location: 'End-of-level reward popup', match_image: 'chest.png', integration: 'widget' } ] },
  { slug: 'fitstreak', name: 'FitStreak', category: 'Fitness', version: '0.9.7', hue: 140, accent: '#16a34a', screens: [
      { key: 'dash', name: 'Dashboard', blocks: [[16, 380, 328, 80], [16, 474, 328, 80]] } ],
    placements: [
      { key: 'dash_hero', name: 'Dashboard hero', shape: 'hero', screen: 'dash', y: 12, kind: 'hero', location: 'Top of the dashboard', match_image: 'dash_hero.png' },
      { key: 'workout_banner', name: 'Workout banner', shape: 'banner', screen: 'dash', y: 41, kind: 'banner', location: 'Between the dashboard and today’s workouts', match_image: 'workout_banner.png' },
      { key: 'streak_icon', name: 'Streak flame', shape: 'square', screen: 'dash', y: 16 + 0, x: 70, kind: 'icon', location: 'Beside the streak counter', match_image: 'flame.png', integration: 'widget' } ] },
];

async function run({ reset = false } = {}) {
  if (reset) for (const t of ['events', 'event_rejects', 'history', 'audit', 'items', 'campaigns', 'creatives', 'placements', 'screens', 'apps', 'users', 'advertisers']) db.exec(`DELETE FROM ${t}`);
  const { ingestApp } = require('./api');
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  const advIds = {};
  for (const a of ADVERTISERS) {
    advIds[a.key] = L.uid('adv');
    db.prepare('INSERT INTO advertisers (id, name, color) VALUES (?,?,?)').run(advIds[a.key], a.name, a.color);
  }
  const pw = L.hashPassword('adforge123');
  db.prepare('INSERT INTO users (id, email, name, role, advertiser_id, pw_hash) VALUES (?,?,?,?,?,?)').run(L.uid('usr'), 'admin@adforge.local', 'Alex Admin', 'admin', null, pw);
  for (const a of ADVERTISERS) {
    db.prepare('INSERT INTO users (id, email, name, role, advertiser_id, pw_hash) VALUES (?,?,?,?,?,?)').run(L.uid('usr'), `${a.key}@adforge.local`, `${a.name} team`, 'advertiser', advIds[a.key], pw);
  }

  // Apps arrive the way TrendPilot would send them.
  const apps = {};
  for (const [n, a] of APPS.entries()) {
    const screens = [];
    for (const s of a.screens) screens.push({ key: s.key, name: s.name, image_base64: (await screenArt(s.name, a.accent, s.blocks)).toString('base64') });
    const placements = [];
    for (const p of a.placements) {
      const sh = SHAPES[p.shape];
      placements.push({ key: p.key, name: p.name, kind: p.kind, location: p.location, screen: p.screen, match_image: p.match_image,
        integration: p.integration || 'asset', x: p.x ?? 0, y: p.y, w: sh.w, h: sh.h, px_w: sh.px_w, px_h: sh.px_h,
        original_base64: (await original(p.name, sh.px_w, sh.px_h, a.hue)).toString('base64') });
    }
    const r = await ingestApp({ slug: a.slug, name: a.name, category: a.category, version: a.version, screens, placements }, { name: 'TrendPilot', role: 'system' });
    apps[a.slug] = r.id;
    // keep creation dates varied
    db.prepare('UPDATE apps SET created_at = ? WHERE id = ?').run(iso(now - (40 - n * 9) * DAY), r.id);
  }

  // Creatives: every advertiser gets all four shapes for the apps they run in.
  const creatives = {};
  async function makeCreatives(appSlug, advKey) {
    const adv = ADVERTISERS.find((x) => x.key === advKey);
    const out = {};
    for (const [shape, sh] of Object.entries(SHAPES)) {
      const img = await L.ingestImage(await creative(adv, sh.px_w, sh.px_h));
      const id = L.uid('cr');
      db.prepare(`INSERT INTO creatives (id, app_id, advertiser_id, name, file, format, width, height, bytes, sha256, created_at, created_by)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, apps[appSlug], advIds[advKey], `${adv.name} ${shape}`, img.file, img.format, img.width, img.height, img.bytes, img.sha256, iso(now - 12 * DAY), `${advKey}@adforge.local`);
      out[shape] = id;
    }
    creatives[`${appSlug}:${advKey}`] = out;
  }
  for (const [s, a] of [['focus-planner', 'brew'], ['focus-planner', 'sprint'], ['sip-water-tracker', 'aqua'], ['sip-water-tracker', 'luma'], ['fitstreak', 'sprint']]) await makeCreatives(s, a);

  const placementIds = (slug) => Object.fromEntries(db.prepare('SELECT key, id FROM placements WHERE app_id = ?').all(apps[slug]).map((r) => [r.key, r.id]));
  const shapeOfKey = (slug, key) => APPS.find((a) => a.slug === slug).placements.find((p) => p.key === key).shape;

  const auditRows = [], historyRows = [], eventPlans = [];
  function campaign({ slug, adv, name, priority, state, start, end, keys, itemWindows = {}, click }) {
    const id = L.uid('cmp');
    const c = { state, start_at: start ? iso(start) : null, end_at: end ? iso(end) : null };
    const eff = L.effective(c, now);
    const created = (start && start < now ? start : now) - 2 * DAY;
    db.prepare(`INSERT INTO campaigns (id, app_id, advertiser_id, name, priority, state, start_at, end_at, last_effective, created_at, created_by)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, apps[slug], advIds[adv], name, priority, state, c.start_at, c.end_at, eff, iso(created), `${adv}@adforge.local`);
    const pids = placementIds(slug);
    const keysAll = keys === 'all' ? Object.keys(pids) : keys;
    for (const k of keysAll) {
      const w = itemWindows[k] || {};
      db.prepare('INSERT INTO items (id, campaign_id, placement_id, creative_id, start_at, end_at, click_url) VALUES (?,?,?,?,?,?,?)')
        .run(L.uid('it'), id, pids[k], creatives[`${slug}:${adv}`][shapeOfKey(slug, k)], w.start ? iso(w.start) : null, w.end ? iso(w.end) : null, click);
    }
    const who = { name: `${ADVERTISERS.find((x) => x.key === adv).name} team`, role: 'advertiser' };
    const base = { entity: 'campaign', entity_id: id, app_id: apps[slug], campaign_id: id };
    auditRows.push([iso(created), who, 'campaign.create', { ...base, detail: { name } }]);
    auditRows.push([iso(created + 600e3), who, keys === 'all' ? 'asset.replace_all' : 'asset.replace_add', { ...base, detail: { replaced: keysAll.length } }]);
    if (state !== 'draft') auditRows.push([iso(created + 3600e3), who, 'campaign.activate', { ...base, detail: { from: 'draft', to: 'enabled' } }]);
    if (state === 'paused') auditRows.push([iso(now - DAY), { name: 'Alex Admin', role: 'admin' }, 'campaign.pause', { ...base, detail: { from: 'enabled', to: 'paused' } }]);
    // history + traffic
    for (const k of keysAll) {
      const w = itemWindows[k] || {};
      const from = Math.max(start || 0, w.start || 0) || start;
      const to = Math.min(end || Infinity, w.end || Infinity);
      if (state === 'enabled' && from && from <= now) {
        const cid = creatives[`${slug}:${adv}`][shapeOfKey(slug, k)];
        historyRows.push([iso(from), apps[slug], pids[k], id, cid, 'live', `${ADVERTISERS.find((x) => x.key === adv).name} ${shapeOfKey(slug, k)} went live (${name})`]);
        if (to <= now) historyRows.push([iso(to), apps[slug], pids[k], null, null, 'original', 'Reverted to the original asset']);
        eventPlans.push({ slug, id, pid: pids[k], cid, from, to: Math.min(to, now), weight: { background: 1.6, hero: 1.2, banner: 1, square: 0.7 }[shapeOfKey(slug, k)] });
      }
    }
    return id;
  }

  tx(() => {
    campaign({ slug: 'focus-planner', adv: 'brew', name: 'Morning Focus', priority: 6, state: 'enabled', start: now - 6 * DAY, end: now + 24 * DAY, keys: 'all', click: 'https://example.com/brewco/morning' });
    campaign({ slug: 'focus-planner', adv: 'sprint', name: 'Move Between Sprints', priority: 7, state: 'enabled', start: now + 3 * DAY, end: now + 20 * DAY, keys: ['home_banner', 'focus_hero'],
      itemWindows: { focus_hero: { start: now + 5 * DAY } }, click: 'https://example.com/sprintfit/free-week' });
    campaign({ slug: 'focus-planner', adv: 'brew', name: 'Weekend Boost', priority: 4, state: 'paused', start: now - 2 * DAY, end: now + 12 * DAY, keys: ['home_banner'], click: 'https://example.com/brewco/weekend' });
    campaign({ slug: 'focus-planner', adv: 'sprint', name: 'Spring Launch', priority: 5, state: 'enabled', start: now - 20 * DAY, end: now - 3 * DAY, keys: ['home_banner', 'timer_bg'], click: 'https://example.com/sprintfit/spring' });
    campaign({ slug: 'sip-water-tracker', adv: 'aqua', name: 'Summer Hydration', priority: 5, state: 'enabled', start: now - 9 * DAY, end: now + 40 * DAY, keys: 'all', click: 'https://example.com/aquapure' });
    campaign({ slug: 'sip-water-tracker', adv: 'luma', name: 'Smart Saver', priority: 5, state: 'draft', start: null, end: null, keys: ['today_banner'], click: 'https://example.com/lumabank' });
    campaign({ slug: 'fitstreak', adv: 'sprint', name: 'Streak Starter', priority: 5, state: 'enabled', start: now - 4 * DAY, end: null, keys: ['dash_hero', 'workout_banner'], click: 'https://example.com/sprintfit/streak' });

    auditRows.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [ts, who, action, f] of auditRows) {
      db.prepare(`INSERT INTO audit (ts, actor, actor_role, action, entity, entity_id, app_id, campaign_id, detail) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(ts, who.name, who.role, action, f.entity, f.entity_id, f.app_id, f.campaign_id, JSON.stringify(f.detail));
    }
    historyRows.sort((a, b) => a[0].localeCompare(b[0]));
    for (const h of historyRows) db.prepare('INSERT INTO history (ts, app_id, placement_id, campaign_id, creative_id, change, note) VALUES (?,?,?,?,?,?,?)').run(...h);

    // Verified traffic: a pool of devices per app, daily volumes with some noise.
    const pool = {};
    const insEv = db.prepare(`INSERT OR IGNORE INTO events (ts, day, app_id, campaign_id, placement_id, creative_id, type, device_id, nonce, dedupe) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (const ep of eventPlans) {
      const appId = apps[ep.slug];
      pool[appId] ??= Array.from({ length: 300 }, () => crypto.randomBytes(8).toString('hex'));
      for (let t = Math.floor(ep.from / DAY) * DAY; t < ep.to; t += DAY) {
        const dayStart = Math.max(t, ep.from), dayEnd = Math.min(t + DAY, ep.to);
        const n = Math.round((30 + rnd() * 50) * ep.weight);
        for (let i = 0; i < n; i++) {
          const ts = iso(dayStart + rnd() * (dayEnd - dayStart));
          const dev = pool[appId][Math.floor(rnd() * pool[appId].length)];
          const nonce = crypto.randomBytes(4).toString('hex');
          insEv.run(ts, ts.slice(0, 10), appId, ep.id, ep.pid, ep.cid, 'impression', dev, nonce, `${nonce}-i-${i}-${ep.pid}`);
          if (rnd() < 0.028) insEv.run(ts, ts.slice(0, 10), appId, ep.id, ep.pid, ep.cid, 'click', dev, nonce, `${nonce}-c-${i}-${ep.pid}`);
        }
      }
    }
    for (const appId of Object.values(apps)) {
      for (const [reason, n] of [['duplicate', 31], ['not_viewable', 18], ['bad_token', 4], ['token_expired', 2]]) {
        for (let i = 0; i < n; i++) db.prepare('INSERT INTO event_rejects (ts, app_id, reason) VALUES (?,?,?)').run(iso(now - rnd() * 7 * DAY), appId, reason);
      }
    }
  });
  L.tick();
  console.log('Seeded demo data. Sign in as admin@adforge.local (password adforge123); advertiser logins are aqua@, brew@, sprint@, luma@ adforge.local.');
}

module.exports = { run };
if (require.main === module) run({ reset: process.argv.includes('--reset') }).catch((e) => { console.error(e); process.exit(1); });
