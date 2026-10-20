// node seed.js [origin]
// Fills seed/ with everything the game needs to run offline, pulled from the real server so the
// ETags match (first online launch then only downloads what changed since the build).
// Default origin is the Pi on the LAN: fast, and no Cloudflare compression in the way.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { key } = require('./proxy');

const ORIGIN = process.argv[2] || 'http://192.168.1.250:16238';
const STATIC = path.join(__dirname, '..', 'static');
const OUT = path.join(__dirname, 'seed');
const PAGES = ['/', '/arena', '/riverland', '/navy', '/changelog'];
const APIS = ['/api/scores', '/api/career/top', '/api/changelog', '/api/daily', '/api/build'];
const SKIP = /^(garage|navylab)\.html$/; // dev pages

function get(url) {
  const mod = ORIGIN.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(ORIGIN + url, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    }).on('error', reject);
  });
}

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (d.isDirectory()) return d.name === 'raw' ? [] : walk(path.join(dir, d.name), rel);
    return SKIP.test(rel) ? [] : [`/static/${rel}`];
  });
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const urls = new Set([...PAGES, ...APIS, ...walk(STATIC)]);
  // the exact ?v= URLs the pages ask for, so the first offline boot hits the cache without the fallback
  for (const p of PAGES) {
    const r = await get(p);
    for (const m of r.body.toString().matchAll(/(?:src|href)="(\/static\/[^"]+)"/g)) urls.add(m[1].replace(/&amp;/g, '&'));
  }
  let bytes = 0;
  let n = 0;
  for (const url of urls) {
    const r = await get(url);
    if (r.status !== 200) { console.log(`skip ${r.status} ${url}`); continue; }
    const meta = { url, t: Date.now(), headers: {} };
    for (const h of ['content-type', 'content-encoding', 'etag', 'last-modified']) if (r.headers[h]) meta.headers[h] = r.headers[h];
    fs.writeFileSync(path.join(OUT, key(url) + '.bin'), r.body);
    fs.writeFileSync(path.join(OUT, key(url) + '.json'), JSON.stringify(meta));
    bytes += r.body.length;
    n++;
  }
  // the home IP the direct route starts with (the app keeps it fresh from /api/direct after that)
  let d = {};
  try { d = JSON.parse((await get('/api/direct')).body.toString()); } catch (e) { /* server too old to have it */ }
  fs.writeFileSync(path.join(OUT, 'direct.json'), JSON.stringify({ ip: d.ip }));
  console.log(`seeded ${n} files, ${(bytes / 1e6).toFixed(1)} MB, direct ip ${d.ip ? 'set' : 'MISSING'}`);
})().catch((e) => { console.error(e); process.exit(1); });
