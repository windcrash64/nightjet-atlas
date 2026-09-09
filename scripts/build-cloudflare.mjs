/** Reproducible Cloudflare deployment package. Only files below dist/ become public.
 * node scripts/build-cloudflare.mjs [--bundled-assets]
 * Standard Static Assets is preferred. --bundled-assets additionally creates a
 * portable Worker fallback for connector environments without asset uploads.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build as buildFrontend } from 'vite';
import { inside, readConfiguration, sha256, sourceFingerprint, parseHeaders, serveBundled, uploadMetadata } from './cloudflare-package.mjs';

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
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('Symlinked asset directories are not allowed.');
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

function fallbackSource(assets, rules) {
  const table = Object.fromEntries(assets.map((asset) => {
    const bytes = readFileSync(asset.localPath);
    const text = /^(text\/|application\/(json|manifest\+json))/.test(asset.mime) || asset.mime === 'image/svg+xml';
    return [asset.path, { body: bytes.toString(text ? 'utf8' : 'base64'), binary: !text, mime: asset.mime, etag: `"${asset.hash}"` }];
  }));
  return `import api from '../../worker/index.js';
const assets = ${JSON.stringify(table)};
const rules = ${JSON.stringify(rules)};
${serveBundled.toString()}
export default { fetch(request,env,ctx) { return new URL(request.url).pathname.startsWith('/api/') ? api.fetch(request,env,ctx) : serveBundled(request,assets,rules); } };
`;
}

export async function buildCloudflare({ bundledAssets = false, root = ROOT, frontend = true } = {}) {
  const out = inside(root, 'worker/.build');
  const configuration = readConfiguration(root);
  const snapshotPath = join(root, 'src', 'data', 'edge-network.json');
  if (!existsSync(snapshotPath)) throw new Error('Published timetable snapshot is missing. Run npm run data:edge before building or testing a clean checkout.');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  if (!snapshot.generatedAt || !Array.isArray(snapshot.sources) || !snapshot.sources.length) throw new Error('Invalid timetable snapshot. Run npm run data:edge -- --force.');
  const epoch = String(snapshot.calendarEpoch);
  const calendarStart = Date.parse(`${epoch.slice(0, 4)}-${epoch.slice(4, 6)}-${epoch.slice(6, 8)}T00:00:00Z`);
  const tomorrow = Date.parse(new Date().toISOString().slice(0, 10)) + 86_400_000;
  if (!Number.isInteger(snapshot.calendarDays) || snapshot.calendarDays < 1 || !Number.isFinite(calendarStart)
    || tomorrow < calendarStart || tomorrow >= calendarStart + snapshot.calendarDays * 86_400_000
    || !Number.isFinite(Date.parse(snapshot.generatedAt))
    || Date.parse(snapshot.generatedAt) > Date.now() + 300_000
    || snapshot.sources.some((source) => !Number.isFinite(Date.parse(source.retrievedAt)) || Date.parse(source.retrievedAt) > Date.now() + 300_000 || Date.now() - Date.parse(source.retrievedAt) > 7 * 86_400_000)) throw new Error('The timetable snapshot is stale or does not cover tomorrow. Run npm run data:edge -- --force.');
  const fingerprint = sourceFingerprint(root);
  if (frontend) await buildFrontend({ root });
  mkdirSync(out, { recursive: true });
  const assets = collectAssets(join(root, 'dist'));
  const headers = readFileSync(join(root, 'dist', '_headers'), 'utf8');
  const headerRules = parseHeaders(headers);
  if (existsSync(join(root, 'dist', '_redirects'))) throw new Error('Static redirects require explicit support in both deployment strategies.');
  const manifest = Object.fromEntries(assets.map((asset) => [asset.path, { hash: asset.hash, size: asset.size }]));
  const standard = await build({ entryPoints: [join(root, 'worker', 'index.js')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'eof' });
  const code = standard.outputFiles[0].contents;
  const size = checkedSize(code, 'API Worker');
  const files = assets.map(({ localPath, ...asset }) => {
    const packagePath = 'assets/' + asset.path.slice(1);
    const destination = inside(out, packagePath);
    mkdirSync(dirname(destination), { recursive: true });
    const bytes = readFileSync(localPath);
    writeFileSync(destination, bytes);
    return { ...asset, packagePath, sha256: sha256(bytes) };
  });
  const buildId = sha256(fingerprint + sha256(code) + JSON.stringify(manifest));
  const summary = { schemaVersion: 2, name: configuration.name, compatibilityDate: configuration.compatibility_date, buildId, sourceFingerprint: fingerprint, assetCount: assets.length,
    assetBytes: assets.reduce((sum, asset) => sum + asset.size, 0), standard: size, assets: assets.map(({ path, size, mime }) => ({ path, size, mime })) };
  const packageFiles = { 'worker.mjs': code, 'asset-manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    'asset-files.json': JSON.stringify(files, null, 2) + '\n', 'worker-metadata.json': JSON.stringify(uploadMetadata(configuration, headers, buildId), null, 2) + '\n',
    'headers.json': JSON.stringify(headerRules, null, 2) + '\n' };
  if (bundledAssets) {
    const frozenAssets = files.map((asset) => ({ ...asset, localPath: inside(out, asset.packagePath) }));
    const fallback = await build({ stdin: { contents: fallbackSource(frozenAssets, headerRules), resolveDir: out, sourcefile: 'fallback-entry.js' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'eof' });
    const fallbackBytes = fallback.outputFiles[0].contents;
    summary.bundled = checkedSize(fallbackBytes, 'Worker with bundled public assets');
    packageFiles['worker-bundled.mjs'] = fallbackBytes;
    packageFiles['worker-bundled-metadata.json'] = JSON.stringify(uploadMetadata(configuration, headers, buildId, true), null, 2) + '\n';
    const { assets: ignoredAssets, $schema: ignoredSchema, ...workerConfig } = configuration;
    packageFiles['wrangler-bundled.json'] = JSON.stringify({ ...workerConfig, main: './worker-bundled.mjs', vars: { ...configuration.vars, BUILD_ID: buildId } }, null, 2) + '\n';
  }
  if (sourceFingerprint(root) !== fingerprint) throw new Error('Deployment sources changed during packaging. Run the build again after edits finish.');
  summary.integrity = Object.fromEntries(Object.entries(packageFiles).map(([path, bytes]) => [path, sha256(bytes)]));
  for (const [path, bytes] of Object.entries(packageFiles)) writeFileSync(join(out, path), bytes);
  // The summary is the commit marker: partially written packages fail integrity checks.
  writeFileSync(join(out, 'package-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--bundled-assets') || args.length > 1) { console.error('Usage: node scripts/build-cloudflare.mjs [--bundled-assets]'); process.exitCode = 1; }
  else buildCloudflare({ bundledAssets: args.includes('--bundled-assets') }).then((summary) => console.log(JSON.stringify(summary, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
