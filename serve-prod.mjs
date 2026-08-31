import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const plan = (await import('./functions/api/plan.js')).onRequestPost;
const geo = (await import('./functions/api/geocode.js')).onRequestGet;
const waitUntil = (p) => p;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.json':'application/json' };

createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/plan')) {
      const c = []; for await (const x of req) c.push(x);
      const out = await plan({ request: new Request('http://x'+req.url, { method:'POST', headers:{'Content-Type':'application/json'}, body: Buffer.concat(c) }), waitUntil, env: {} });
      return res.writeHead(out.status, {'Content-Type':'application/json'}).end(await out.text());
    }
    if (req.url.startsWith('/api/geocode')) {
      const out = await geo({ request: new Request('http://x'+req.url), waitUntil });
      return res.writeHead(out.status, {'Content-Type':'application/json'}).end(await out.text());
    }
    const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const buf = await readFile(join('dist', p)).catch(() => readFile(join('dist','index.html')));
    res.writeHead(200, {'Content-Type': TYPES[extname(p)] || 'text/html'}).end(buf);
  } catch (e) { res.writeHead(500).end(String(e)); }
}).listen(4499, () => console.log('prod build on http://127.0.0.1:4499'));
