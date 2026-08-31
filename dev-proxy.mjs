import { createServer } from 'node:http';
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const plan = (await import('./functions/api/plan.js')).onRequestPost;
const geo = (await import('./functions/api/geocode.js')).onRequestGet;
const waitUntil = (p) => p;

createServer(async (req, res) => {
  const url = `http://localhost:8790${req.url}`;
  try {
    let out;
    if (req.url.startsWith('/api/plan')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      out = await plan({ request: new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.concat(chunks) }), waitUntil, env: {} });
    } else if (req.url.startsWith('/api/geocode')) {
      out = await geo({ request: new Request(url), waitUntil });
    } else { res.writeHead(404).end('no'); return; }
    const body = await out.text();
    res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(body);
  } catch (e) { res.writeHead(500).end(JSON.stringify({ error: String(e) })); }
}).listen(8790, () => console.log('api proxy on 8790'));
