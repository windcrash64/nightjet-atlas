/** Reproducible Cloudflare deployment package. Only files below dist/ become public.
 * node scripts/build-cloudflare.mjs [--bundled-assets]
 * Standard Static Assets is preferred. --bundled-assets additionally creates a
 * portable Worker fallback for connector environments without asset uploads.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'worker', '.build');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const FREE_WORKER_GZIP_LIMIT = 3 * 1024 * 1024;

export function assetHash(bytes, filename) {
  // Same documented algorithm as Cloudflare's direct-upload example.
  return createHash('sha256').update(bytes.toString('base64') + extname(filename).slice(1)).digest('hex').slice(0, 32);
}

export function collectAssets(directory = join(ROOT, 'dist')) {
  const root = resolve(directory);
  if (!existsSync(join(root, 'index.html'))) throw new Error('Run npm run build before packaging Cloudflare.');
  const assets = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(current, entry.name);
      if (!path.startsWith(root + sep)) throw new Error('Asset path escaped dist/.');
      if (entry.isSymbolicLink()) throw new Error('Symlinked assets are not allowed.');
      if (entry.name.startsWith('.') || ['_headers', '_redirects'].includes(entry.name) || entry.name.endsWith('.map')) continue;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) continue;
      const mime = MIME[extname(entry.name).toLowerCase()];
      if (!mime) throw new Error(`Unknown asset MIME type: ${entry.name}`);
      const bytes = readFileSync(path);
      if (bytes.length > 25 * 1024 * 1024) throw new Error(`Asset exceeds the Static Assets file limit: ${entry.name}`);
      const assetPath = '/' + relative(root, path).split(sep).join('/');
      assets.push({ path: assetPath, hash: assetHash(bytes, entry.name), size: bytes.length, mime, localPath: path });
    }
  }
  walk(root);
  return assets;
}

function checkedSize(bytes, label) {
  const gzipBytes = gzipSync(bytes, { level: 9 }).length;
  if (gzipBytes >= FREE_WORKER_GZIP_LIMIT) throw new Error(`${label} exceeds the 3 MiB gzip Worker limit (${gzipBytes} bytes).`);
  return { rawBytes: bytes.length, gzipBytes, limitBytes: FREE_WORKER_GZIP_LIMIT };
}

function fallbackSource(assets) {
  const table = Object.fromEntries(assets.map((asset) => {
    const bytes = readFileSync(asset.localPath);
    const text = /^(text\/|application\/(json|manifest\+json))/.test(asset.mime) || asset.mime === 'image/svg+xml';
    return [asset.path, { body: bytes.toString(text ? 'utf8' : 'base64'), binary: !text, mime: asset.mime, etag: `"${asset.hash}"` }];
  }));
  return `import api from '../../worker/index.js';
const assets = ${JSON.stringify(table)};
function serve(request) {
  if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed', {status:405,headers:{allow:'GET, HEAD'}});
  const path = new URL(request.url).pathname;
  const file = assets[path] || (path === '/' || (!path.startsWith('/assets/') && !path.split('/').pop().includes('.')) ? assets['/index.html'] : null);
  if (!file) return new Response('Not found',{status:404});
  const headers = {'content-type':file.mime,'x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'strict-origin-when-cross-origin','etag':file.etag,'cache-control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'public, max-age=0, must-revalidate'};
  if (request.headers.get('if-none-match') === file.etag) return new Response(null,{status:304,headers});
  const body = request.method === 'HEAD' ? null : file.binary ? Uint8Array.from(atob(file.body),c=>c.charCodeAt(0)) : file.body;
  return new Response(body,{headers});
}
export default { fetch(request,env) { return new URL(request.url).pathname.startsWith('/api/') ? api.fetch(request,env) : serve(request); } };
`;
}

export async function buildCloudflare({ bundledAssets = false } = {}) {
  mkdirSync(OUT, { recursive: true });
  const assets = collectAssets();
  const manifest = Object.fromEntries(assets.map((asset) => [asset.path, { hash: asset.hash, size: asset.size }]));
  const standard = await build({ entryPoints: [join(ROOT, 'worker', 'index.js')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'eof' });
  const code = standard.outputFiles[0].contents;
  const size = checkedSize(code, 'API Worker');
  writeFileSync(join(OUT, 'worker.mjs'), code);
  writeFileSync(join(OUT, 'asset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // This file contains public assets and local paths only, never provider credentials.
  writeFileSync(join(OUT, 'asset-files.json'), JSON.stringify(assets, null, 2) + '\n');
  const configuration = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'));
  const summary = { name: configuration.name, compatibilityDate: configuration.compatibility_date, assetCount: assets.length,
    assetBytes: assets.reduce((sum, asset) => sum + asset.size, 0), standard: size, assets: assets.map(({ path, size, mime }) => ({ path, size, mime })) };
  if (bundledAssets) {
    const fallback = await build({ stdin: { contents: fallbackSource(assets), resolveDir: join(ROOT, 'worker', '.build'), sourcefile: 'fallback-entry.js' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'eof' });
    const fallbackBytes = fallback.outputFiles[0].contents;
    summary.bundled = checkedSize(fallbackBytes, 'Worker with bundled public assets');
    writeFileSync(join(OUT, 'worker-bundled.mjs'), fallbackBytes);
    writeFileSync(join(OUT, 'wrangler-bundled.json'), JSON.stringify({ name: configuration.name, main: './worker-bundled.mjs', compatibility_date: configuration.compatibility_date, observability: { enabled: false } }, null, 2) + '\n');
  }
  writeFileSync(join(OUT, 'package-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildCloudflare({ bundledAssets: process.argv.includes('--bundled-assets') }).then((summary) => console.log(JSON.stringify(summary, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
