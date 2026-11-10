const express = require('express');
const path = require('path');
const { db, UPLOAD_DIR } = require('./db');
const L = require('./lib');
const api = require('./api');
const sdk = require('./sdk');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use('/media', express.static(UPLOAD_DIR, { immutable: true, maxAge: '365d', index: false, setHeaders: (r) => r.set('access-control-allow-origin', '*') }));
  app.use('/sdk/v1', sdk.router);
  app.use('/api', express.json({ limit: '60mb' }), api.router);
  app.use(express.static(path.join(__dirname, '..', '..', 'web'), { extensions: ['html'] }));
  return app;
}

async function main() {
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get() && process.env.SEED !== '0') await require('./seed').run();
  L.tick();
  setInterval(() => { try { L.tick(); } catch (e) { console.error('tick failed', e); } }, 15000).unref();
  const port = parseInt(process.env.PORT, 10) || 8300;
  createApp().listen(port, () => console.log(`AdForge running at http://localhost:${port}`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createApp };
