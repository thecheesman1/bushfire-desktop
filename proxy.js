// The game window only ever talks to this little server on 127.0.0.1. It serves the game out of a
// disk cache (seeded at build time) and forwards everything to whichever upstream answers:
//   1. https://ww3.bin-chicken.org (Cloudflare tunnel)
//   2. the home IP direct route (router 443 -> Caddy :16443 on the Pi, self-signed cert pinned here)
//   3. nobody: offline. Cached files + last leaderboards, POSTs bounce, websocket refused = solo only.
// Online, every file is revalidated against the server (ETag), so the app updates itself and only
// pulls what changed. The game's own code has no idea any of this exists: all its URLs are relative.
const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOMAIN = 'ww3.bin-chicken.org';
const NO_CACHE = new Set(['/healthz', '/api/lobbies', '/api/direct']); // stale copies of these would lie
const DROP_UP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer',
  'transfer-encoding', 'accept-encoding', 'if-none-match', 'if-modified-since', 'content-length']);
const DROP_DOWN = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'cache-control', 'etag',
  'last-modified', 'alt-svc', 'strict-transport-security', 'report-to', 'nel', 'server', 'cf-ray', 'cf-cache-status', 'age', 'expires']);
const KEEP_META = ['content-type', 'content-encoding', 'etag', 'last-modified'];

const key = (url) => crypto.createHash('sha1').update(url).digest('hex');
// Cloudflare compresses even tiny JSON
function unzip(body, enc) {
  if (enc === 'gzip') return zlib.gunzipSync(body);
  if (enc === 'br') return zlib.brotliDecompressSync(body);
  if (enc === 'deflate') return zlib.inflateSync(body);
  return body;
}
const json = (r) => JSON.parse(unzip(r.body, r.headers['content-encoding']).toString());
const isPage = (p) => !p.startsWith('/static/') && !p.startsWith('/api/') && p !== '/healthz';

function createProxy({ port, cacheDir, seedDir, cert, stateFile, log = () => {} }) {
  const local = `http://127.0.0.1:${port}`;
  fs.mkdirSync(cacheDir, { recursive: true });
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { /* first launch */ }
  if (!state.directIp) {
    try { state.directIp = JSON.parse(fs.readFileSync(path.join(seedDir, 'direct.json'), 'utf8')).ip; } catch (e) { /* built without one */ }
  }
  const save = () => { try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (e) { /* meh */ } };

  // BF_DIRECT=192.168.1.250:16443 + BF_FORCE=direct tests the direct route from inside the LAN
  function upstreams() {
    const list = [{ name: 'domain', host: DOMAIN, port: 443, tls: { servername: DOMAIN } }];
    const [dh, dp] = (process.env.BF_DIRECT || '').split(':');
    const host = dh || state.directIp;
    // servername '' = no SNI (it's an IP); trust exactly our cert and skip the hostname check, the IP moves
    if (host) list.push({ name: 'direct', host, port: +dp || 443, tls: { servername: '', ca: cert, checkServerIdentity: () => undefined } });
    return process.env.BF_FORCE ? list.filter((u) => u.name === process.env.BF_FORCE) : list;
  }

  function request(up, { method = 'GET', url, headers = {}, body, timeout = 15000 }) {
    return new Promise((resolve, reject) => {
      const req = https.request({ host: up.host, port: up.port, method, path: url, timeout, ...up.tls,
        headers: { ...headers, host: DOMAIN, 'accept-encoding': 'gzip, deflate, br' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }

  // ---- which upstream are we on ----
  let current = null;
  let probing = null;
  let lastProbe = 0;
  function probe() {
    if (probing) return probing;
    lastProbe = Date.now();
    probing = (async () => {
      for (const up of upstreams()) {
        try {
          const r = await request(up, { url: '/healthz', timeout: 3500 });
          if (r.status === 200 && json(r).ok) return pick(up);
        } catch (e) { log(`${up.name} (${up.host}) unreachable: ${e.message}`); }
      }
      return pick(null);
    })().finally(() => { probing = null; });
    return probing;
  }
  function pick(up) {
    if ((up && up.name) !== (current && current.name)) log(up ? `online via ${up.name} (${up.host})` : 'OFFLINE: solo only');
    current = up;
    if (up) {
      state.lastOnline = Date.now();
      save();
      // learn the home IP while we can, so the direct route still works on a network that blocks the domain
      if (up.name === 'domain') {
        request(up, { url: '/api/direct', timeout: 8000 }).then((r) => {
          const d = json(r);
          if (d.ip && d.ip !== state.directIp) { state.directIp = d.ip; save(); log(`direct route -> ${d.ip}`); }
        }).catch(() => {});
      }
    }
    return up;
  }
  async function upstream() {
    if (probing) return probing;
    if (!current && Date.now() - lastProbe > 10000) return probe(); // offline: knock again every so often
    return current;
  }

  // ---- disk cache: <sha1>.bin = body exactly as the server sent it, <sha1>.json = headers ----
  function readEntry(dir, url) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, key(url) + '.json'), 'utf8'));
      return { meta, body: fs.readFileSync(path.join(dir, key(url) + '.bin')) };
    } catch (e) { return null; }
  }
  function cached(url) {
    // ?v=mtime / ?hot=hash change every deploy: fall back to the bare path
    const bare = url.split('?')[0];
    const tries = url.startsWith('/static/') && bare !== url ? [url, bare] : [url];
    for (const u of tries) for (const dir of [cacheDir, seedDir]) { const e = readEntry(dir, u); if (e) return e; }
    return null;
  }
  function store(url, res) {
    const meta = { url, t: Date.now(), headers: {} };
    for (const h of KEEP_META) if (res.headers[h]) meta.headers[h] = res.headers[h];
    const f = path.join(cacheDir, key(url));
    try {
      fs.writeFileSync(f + '.bin.tmp', res.body);
      fs.renameSync(f + '.bin.tmp', f + '.bin');
      fs.writeFileSync(f + '.json', JSON.stringify(meta));
      if (url.includes('?')) { // the bare path always holds the newest copy too, for the fallback above
        const b = path.join(cacheDir, key(url.split('?')[0]));
        fs.copyFileSync(f + '.bin', b + '.bin');
        fs.writeFileSync(b + '.json', JSON.stringify({ ...meta, url: url.split('?')[0] }));
      }
    } catch (e) { log(`cache write failed: ${e.message}`); }
  }

  function send(req, res, status, headers, body) {
    const h = {};
    for (const [k, v] of Object.entries(headers)) if (!DROP_DOWN.has(k) && !k.startsWith('cf-')) h[k] = v;
    if (h.location) h.location = h.location.replace(`https://${DOMAIN}`, local);
    h['cache-control'] = 'no-cache'; // the browser always asks us, we do the real caching
    h['content-length'] = body.length;
    res.writeHead(status, h);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // offline pages get a strip across the top so nobody wonders why their XP isn't banking
  function offlinePage(entry) {
    let html;
    try { html = unzip(entry.body, entry.meta.headers['content-encoding']); } catch (e) { return entry; }
    const when = state.lastOnline ? new Date(state.lastOnline).toLocaleString() : 'never';
    const bar = `<div style="position:fixed;top:0;left:0;right:0;z-index:99999;padding:6px;text-align:center;background:#7a1d12;color:#fff;font:13px 'Share Tech Mono',monospace;letter-spacing:1px;pointer-events:none">OFFLINE // SOLO ONLY // PROGRESS WON'T SAVE // LEADERBOARDS FROM ${when}</div>`;
    const out = Buffer.from(html.toString().replace('</body>', bar + '</body>'));
    const headers = { ...entry.meta.headers };
    delete headers['content-encoding'];
    return { meta: { ...entry.meta, headers }, body: out };
  }

  function serveOffline(req, res, url) {
    const p = url.split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 503, { 'content-type': 'application/json' }, Buffer.from('{"error":"offline"}'));
    const entry = !NO_CACHE.has(p) && cached(url);
    if (!entry) return send(req, res, p.startsWith('/api/') || p === '/healthz' ? 503 : 404, { 'content-type': 'text/plain' }, Buffer.from('offline'));
    const e = isPage(p) && String(entry.meta.headers['content-type']).includes('html') ? offlinePage(entry) : entry;
    send(req, res, 200, e.meta.headers, e.body);
  }

  function upHeaders(req) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_UP.has(k)) h[k] = typeof v === 'string' ? v.split(local).join(`https://${DOMAIN}`) : v;
    return h;
  }

  async function handle(req, res) {
    const url = req.url;
    const p = url.split('?')[0];
    const body = await new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
    for (let attempt = 0; attempt < 2; attempt++) {
      const up = await upstream();
      if (!up) return serveOffline(req, res, url);
      const isGet = req.method === 'GET';
      const have = isGet && !NO_CACHE.has(p) ? cached(url) : null;
      // ?v=mtime / ?hot=hash URLs never change content: no need to even ask
      if (have && have.meta.url === url && /^\/static\/.*[?&](v|hot)=/.test(url)) return send(req, res, 200, have.meta.headers, have.body);
      const headers = upHeaders(req);
      if (have && have.meta.url === url) { // only revalidate an exact match, a bare-path fallback is a different file
        if (have.meta.headers.etag) headers['if-none-match'] = have.meta.headers.etag;
        if (have.meta.headers['last-modified']) headers['if-modified-since'] = have.meta.headers['last-modified'];
      }
      let r;
      try {
        r = await request(up, { method: req.method, url, headers, body: body.length ? body : undefined });
      } catch (e) {
        log(`${req.method} ${url} via ${up.name} failed: ${e.message}`);
        current = null;
        await probe();
        continue;
      }
      if (r.status === 304 && have) return send(req, res, 200, have.meta.headers, have.body);
      if (isGet && r.status === 200 && !NO_CACHE.has(p)) store(url, r);
      return send(req, res, r.status, r.headers, r.body);
    }
    return serveOffline(req, res, url);
  }

  // websocket: splice raw bytes both ways, the server and the game handle the actual protocol
  async function upgrade(req, sock, head) {
    sock.on('error', () => {});
    const up = await upstream();
    if (!up) return sock.destroy(); // net.js sees the failure -> "COULD NOT REACH SERVER", solo still works
    const upSock = tls.connect({ host: up.host, port: up.port, ...up.tls }, () => {
      upSock.setTimeout(0);
      const h = upHeaders(req);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, `host: ${DOMAIN}`, 'connection: Upgrade', 'upgrade: websocket'];
      for (const [k, v] of Object.entries(h)) lines.push(`${k}: ${v}`);
      upSock.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upSock.write(head);
      upSock.pipe(sock);
      sock.pipe(upSock);
    });
    upSock.setTimeout(8000, () => upSock.destroy());
    const kill = () => { sock.destroy(); upSock.destroy(); };
    upSock.on('error', (e) => { log(`ws via ${up.name} failed: ${e.message}`); kill(); });
    upSock.on('close', kill);
    sock.on('close', kill);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { log(`proxy error: ${e.stack}`); if (!res.headersSent) { res.writeHead(502); res.end(); } });
  });
  server.on('upgrade', (req, sock, head) => { upgrade(req, sock, head).catch(() => sock.destroy()); });

  return {
    probe,
    status: () => (current ? current.name : 'offline'),
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }),
  };
}

module.exports = { createProxy, key, DOMAIN };
