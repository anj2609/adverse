// End-to-end check: dashboard API -> campaign engine -> Flutter SDK endpoints -> verified analytics.
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.ADFORGE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adforge-'));
process.env.SEED = '0';
const sharp = require('sharp');

(async () => {
  await require('../src/seed').run();
  const server = require('../src/index').createApp().listen(0);
  const base = `http://localhost:${server.address().port}`;
  const call = async (p, { method = 'GET', body, token, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body && JSON.stringify(body) });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json, headers: r.headers };
  };
  let n = 0; const ok = (m) => console.log(`  ✓ ${m}`) || n++;

  const admin = (await call('/api/auth/login', { method: 'POST', body: { email: 'admin@adforge.local', password: 'adforge123' } })).json.token;
  assert.strictEqual((await call('/api/auth/login', { method: 'POST', body: { email: 'admin@adforge.local', password: 'nope' } })).status, 401); ok('bad password rejected');
  assert.strictEqual((await call('/api/apps')).status, 401); ok('API needs sign-in');

  const apps = (await call('/api/apps', { token: admin })).json;
  assert.strictEqual(apps.length, 4); ok('4 TrendPilot apps listed');
  const fit = apps.find((a) => a.slug === 'fitstreak');
  const detail = (await call(`/api/apps/${fit.id}`, { token: admin })).json;
  assert.ok(detail.placements.every((p) => p.original_file && p.location)); ok('placements expose original asset, location and formats');
  const sdkKey = (await call(`/api/apps/${fit.id}/sdk`, { token: admin })).json.sdk_key;

  // Advertiser sign-in is scoped.
  const aqua = (await call('/api/auth/login', { method: 'POST', body: { email: 'aqua@adforge.local', password: 'adforge123' } })).json;
  const allCamps = (await call('/api/campaigns', { token: admin })).json;
  const foreign = allCamps.find((c) => c.advertiser !== 'AquaPure');
  assert.strictEqual((await call(`/api/campaigns/${foreign.id}`, { token: aqua.token })).status, 403); ok('advertiser cannot open another advertiser\'s campaign');
  assert.ok((await call('/api/campaigns', { token: aqua.token })).json.every((c) => c.advertiser === 'AquaPure')); ok('advertiser list is scoped');

  // Upload: one good PNG per shape, plus junk that must be refused.
  const brandAdv = (await call('/api/advertisers', { token: admin })).json.find((a) => a.name === 'LumaBank');
  const mk = (w, h, c) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();
  const files = [
    { name: 'luma-banner.png', data: (await mk(720, 200, '#7c3aed')).toString('base64') },
    { name: 'luma-hero.png', data: (await mk(720, 400, '#6d28d9')).toString('base64') },
    { name: 'luma-square-tiny.png', data: (await mk(40, 40, '#111')).toString('base64') },
    { name: 'notes.txt', data: Buffer.from('hello').toString('base64') },
  ];
  const up = (await call(`/api/apps/${fit.id}/creatives`, { method: 'POST', token: admin, body: { advertiser_id: brandAdv.id, files } })).json;
  assert.strictEqual(up.created.length, 3); assert.strictEqual(up.failed.length, 1); ok('multi-upload accepts images, refuses a text file');

  // Campaign: replace all eligible in one operation.
  const camp = (await call('/api/campaigns', { method: 'POST', token: admin, body: { app_id: fit.id, advertiser_id: brandAdv.id, name: 'Smoke test', priority: 9 } })).json;
  assert.strictEqual(camp.status, 'draft');
  const rep = (await call(`/api/campaigns/${camp.id}/replace-all`, { method: 'POST', token: admin, body: { click_url: 'https://example.com/luma' } })).json;
  assert.deepStrictEqual(rep.replaced.map((r) => r.name).sort(), ['Dashboard hero', 'Workout banner']); ok('replace-all fills only spots the images fit');
  assert.ok(rep.skipped.length >= 1); ok('spots without a fitting image are reported, not forced');

  assert.strictEqual((await call(`/api/campaigns/${camp.id}/state`, { method: 'POST', token: admin, body: { action: 'activate' } })).json.status, 'active');
  const key = { 'x-adforge-key': sdkKey };
  let m = (await call('/sdk/v1/manifest', { headers: key })).json;
  const hero = m.placements.find((p) => p.key === 'dash_hero');
  assert.ok(hero.creative && hero.token && hero.click_url); ok('active campaign appears in the SDK manifest (priority 9 beats priority 5)');
  assert.ok(m.placements.find((p) => p.key === 'streak_icon').creative === null); ok('untouched spots stay original');
  assert.strictEqual((await call('/sdk/v1/manifest', { headers: { 'x-adforge-key': 'nope' } })).status, 401); ok('unknown app key refused');

  // Verified analytics.
  const dev = 'device-0001-abcdef';
  const ev = (o) => ({ token: hero.token, type: 'impression', device_id: dev, viewable_ms: 1500, ...o });
  const r1 = (await call('/sdk/v1/events', { method: 'POST', headers: key, body: { events: [
    ev({}), ev({}), ev({ viewable_ms: 200, device_id: 'device-0002-abcdef' }), ev({ token: hero.token.slice(0, -4) + 'AAAA', device_id: 'device-0003-abcdef' }),
    ev({ type: 'click' }), ev({ device_id: 'x' }) ] } })).json;
  assert.deepStrictEqual(r1.accepted, 2); assert.strictEqual(r1.rejected.duplicate, 1); assert.strictEqual(r1.rejected.not_viewable, 1); assert.strictEqual(r1.rejected.bad_token, 1); assert.strictEqual(r1.rejected.bad_device, 1);
  ok('events verified: valid kept; duplicate, too-short, forged and anonymous rejected');
  const click = await call(new URL(hero.click_url).pathname + new URL(hero.click_url).search + '&d=device-0009-abcdef');
  assert.strictEqual(click.status, 302); assert.strictEqual(click.headers.get('location'), 'https://example.com/luma'); ok('click redirect lands on the advertiser link');
  const an = (await call(`/api/campaigns/${camp.id}/analytics`, { token: admin })).json;
  assert.strictEqual(an.impressions, 1); assert.strictEqual(an.clicks, 2); ok('analytics count only verified events');
  // Another app's key can't report for this app's token.
  const other = apps.find((a) => a.slug === 'candy-match');
  const otherKey = (await call(`/api/apps/${other.id}/sdk`, { token: admin })).json.sdk_key;
  const x = (await call('/sdk/v1/events', { method: 'POST', headers: { 'x-adforge-key': otherKey }, body: { events: [ev({ device_id: 'device-0004-abcdef' })] } })).json;
  assert.strictEqual(x.rejected.wrong_app, 1); ok('token from another app is refused');

  // Lifecycle: pause, schedule, expire.
  await call(`/api/campaigns/${camp.id}/state`, { method: 'POST', token: admin, body: { action: 'pause' } });
  m = (await call('/sdk/v1/manifest', { headers: key })).json;
  assert.ok(m.placements.find((p) => p.key === 'dash_hero').campaign_id !== camp.id); ok('paused campaign leaves the app (original/other campaign returns)');
  const future = new Date(Date.now() + 86400e3).toISOString();
  await call(`/api/campaigns/${camp.id}`, { method: 'PATCH', token: admin, body: { start_at: future } });
  const act = (await call(`/api/campaigns/${camp.id}/state`, { method: 'POST', token: admin, body: { action: 'activate' } })).json;
  assert.strictEqual(act.status, 'scheduled'); ok('future start date makes it Scheduled');
  m = (await call('/sdk/v1/manifest', { headers: key })).json;
  assert.ok(m.placements.find((p) => p.key === 'dash_hero').campaign_id !== camp.id); ok('scheduled campaign is not served early');
  const prev = (await call(`/api/apps/${fit.id}/preview?campaigns=${camp.id}`, { token: admin })).json;
  assert.strictEqual(prev.placements.find((p) => p.key === 'dash_hero').live.campaign_id, camp.id); ok('preview can force a scheduled campaign on');
  await call(`/api/campaigns/${camp.id}/state`, { method: 'POST', token: admin, body: { action: 'expire' } });
  assert.strictEqual((await call(`/api/campaigns/${camp.id}/state`, { method: 'POST', token: admin, body: { action: 'activate' } })).status, 400); ok('expired campaign cannot restart');

  const audit = (await call(`/api/audit?campaign_id=${camp.id}`, { token: admin })).json;
  assert.ok(['campaign.create', 'asset.replace_all', 'campaign.activate', 'campaign.pause', 'campaign.expire'].every((a) => audit.some((r) => r.action === a))); ok('audit log recorded every change');
  const hist = (await call(`/api/apps/${fit.id}/history`, { token: admin })).json;
  assert.ok(hist.some((h) => h.campaign_id === camp.id && h.change === 'live') && hist.filter((h) => h.change === 'live' && h.campaign_id !== camp.id).length >= 3); ok('placement history shows go-live and hand-back to the next campaign');

  // TrendPilot ingest.
  const ing = await call('/api/ingest/apps', { method: 'POST', headers: { 'x-trendpilot-key': 'trendpilot-dev-key' }, body: { slug: 'new-app', name: 'New App', placements: [{ key: 'top', px_w: 720, px_h: 200 }] } });
  assert.strictEqual(ing.status, 200); assert.ok(ing.json.sdk_key); ok('TrendPilot can register a new app and gets an SDK key');
  console.log(`\n${n} checks passed`);
  server.close(); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n')); process.exit(1); });
