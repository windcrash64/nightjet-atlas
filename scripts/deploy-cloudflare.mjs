/** Standard Cloudflare Static Assets deploy, with connector-compatible pieces.
 * Fully automated CI: CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/deploy-cloudflare.mjs
 * Connector: `manifest` emits public manifest; create upload session with the connector;
 * `upload-assets` reads one JSON line {accountId,jwt,buckets} from stdin, writes one
 * JSON line {jwt} for the caller to capture (a short-lived completion credential).
 * `connector-package` emits code + metadata WITHOUT credentials for tool orchestration.
 * Never save either JWT output to a repository file or display it to the traveler.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetHash, ROOT, OUT } from './build-cloudflare.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const accountPattern = /^[a-f0-9]{32}$/;
const scriptPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function readPackage() {
  const summary = JSON.parse(readFileSync(join(OUT, 'package-summary.json'), 'utf8'));
  const files = JSON.parse(readFileSync(join(OUT, 'asset-files.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(OUT, 'asset-manifest.json'), 'utf8'));
  if (!scriptPattern.test(summary.name)) throw new Error('Invalid Worker name.');
  return { summary, files, manifest };
}

async function api(path, options, credential) {
  const response = await fetch(API + path, { ...options, headers: { authorization: `Bearer ${credential}`, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  const body = await response.json();
  if (!response.ok || !body.success) {
    // Cloudflare messages can reflect request data; only stable error codes leave this helper.
    const codes = Array.isArray(body.errors) ? body.errors.map((entry) => entry.code).filter((code) => typeof code === 'number').join(',') : '';
    throw new Error(`Cloudflare request failed: HTTP ${response.status}${codes ? ` (codes ${codes})` : ''}.`);
  }
  return body.result;
}

export async function uploadAssets(session, fetchApi = api) {
  if (!accountPattern.test(session?.accountId || '') || typeof session?.jwt !== 'string' || !session.jwt || !Array.isArray(session.buckets)) throw new Error('A valid account and asset-upload session are required.');
  const { files } = readPackage();
  const byHash = new Map(files.map((file) => [file.hash, file]));
  if (!session.buckets.length) return session.jwt;
  let completionJwt;
  for (const bucket of session.buckets) {
    if (!Array.isArray(bucket) || bucket.some((hash) => !byHash.has(hash))) throw new Error('The upload session contains an unknown asset. Rebuild the package.');
    const form = new FormData();
    for (const hash of bucket) {
      const file = byHash.get(hash);
      const bytes = readFileSync(file.localPath);
      if (bytes.length !== file.size || assetHash(bytes, file.path) !== hash) throw new Error('An asset changed after packaging. Build a new package before deploying.');
      form.append(hash, new Blob([bytes.toString('base64')], { type: file.mime }), hash);
    }
    const result = await fetchApi(`/accounts/${session.accountId}/workers/assets/upload?base64=true`, { method: 'POST', body: form }, session.jwt);
    if (typeof result?.jwt === 'string') completionJwt = result.jwt;
  }
  if (!completionJwt) throw new Error('Cloudflare did not return a completed asset-upload token.');
  return completionJwt;
}

export function workerPackage({ bundled = false } = {}) {
  const { summary } = readPackage();
  const configuration = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'));
  const rates = configuration.ratelimits || [{ name: 'SEARCH_RATE_LIMITER', namespace_id: '1001', simple: { limit: 20, period: 60 } }];
  const headers = readFileSync(join(ROOT, 'dist', '_headers'), 'utf8');
  const metadata = { main_module: 'worker.mjs', compatibility_date: summary.compatibilityDate,
    keep_bindings: ['secret_text', 'plain_text'], bindings: [
      ...(!bundled ? [{ type: 'assets', name: 'ASSETS' }] : []),
      ...rates.map((binding) => ({ type: 'ratelimit', ...binding })),
      ...Object.entries(configuration.vars || {}).map(([name, value]) => typeof value === 'string' ? { type: 'plain_text', name, text: value } : { type: 'json', name, json: value }),
    ],
    observability: { enabled: false },
    ...(!bundled ? { assets: { config: { not_found_handling: 'single-page-application', run_worker_first: ['/api/*'], _headers: headers } } } : {}),
  };
  return { name: summary.name, metadata, code: readFileSync(join(OUT, bundled ? 'worker-bundled.mjs' : 'worker.mjs'), 'utf8') };
}

export async function deploy({ accountId, token }) {
  if (!accountPattern.test(accountId || '') || !token) throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for CI deployment.');
  const { summary, manifest } = readPackage();
  const session = await api(`/accounts/${accountId}/workers/scripts/${summary.name}/assets-upload-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }) }, token);
  const jwt = await uploadAssets({ ...session, accountId });
  const packaged = workerPackage();
  packaged.metadata.assets.jwt = jwt;
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(packaged.metadata)], { type: 'application/json' }));
  form.append('worker.mjs', new Blob([packaged.code], { type: 'application/javascript+module' }), 'worker.mjs');
  const uploaded = await api(`/accounts/${accountId}/workers/scripts/${summary.name}`, { method: 'PUT', body: form }, token);
  await api(`/accounts/${accountId}/workers/scripts/${summary.name}/subdomain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, previews_enabled: false }) }, token);
  const subdomain = await api(`/accounts/${accountId}/workers/subdomain`, { method: 'GET' }, token);
  return { name: summary.name, url: `https://${summary.name}.${subdomain.subdomain}.workers.dev`, versionId: uploaded.id || null };
}

export async function readInputLine() {
  // Raw terminal mode disables echo for scoped upload JWTs supplied interactively.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  let value = '';
  try {
    for await (const chunk of process.stdin) {
      value += chunk;
      if (value.length > 100_000) throw new Error('Deployment session input is too large.');
      if (value.includes('\u0003')) throw new Error('Deployment input cancelled.');
      if (value.includes('\n') || value.includes('\r')) break;
    }
    return JSON.parse(value.trim());
  } finally {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (typeof process.stdin.unref === 'function') process.stdin.unref();
  }
}

export async function verifyDeployment(url) {
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.workers.dev')) throw new Error('Verify a public HTTPS workers.dev deployment.');
  const { files } = readPackage();
  const checked = await Promise.all(files.map(async (file) => {
    const response = await fetch(new URL(file.path, origin), { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Public asset returned HTTP ${response.status}: ${file.path}`);
    if (!response.headers.get('content-type')?.startsWith(file.mime.split(';')[0])) throw new Error(`Incorrect public MIME type: ${file.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (assetHash(bytes, file.path) !== file.hash) throw new Error(`Public asset differs from the approved build: ${file.path}`);
    return file.path;
  }));
  const healthResponse = await fetch(new URL('/api/health', origin), { signal: AbortSignal.timeout(20_000) });
  const health = await healthResponse.json();
  if (!healthResponse.ok || !health.ok) throw new Error('Public API health failed.');
  const query = { from: { name: 'Berlin', lat: 52.52, lon: 13.405, iata: 'BER' }, to: { name: 'Munich', lat: 48.137, lon: 11.575, iata: 'MUC' }, date: '2026-09-10', adults: 1, cabin: 'economy', modes: ['plane', 'train', 'bus', 'metro'] };
  const plan = async (body) => {
    const response = await fetch(new URL('/api/plan', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`Public journey search failed: HTTP ${response.status}.`);
    if (/x-api-key|sessionToken|SKYSCANNER_API_KEY|Bearer /i.test(JSON.stringify(result))) throw new Error('An internal credential field appeared in a public response.');
    return result;
  };
  const result = await plan(query);
  const rail = result.journeys.filter((journey) => journey.provider === 'rail');
  if (rail.length !== 8 || rail.some((journey) => journey.price !== null)) throw new Error('Expected eight unpriced published Berlin–Munich timetable journeys.');
  const outside = await plan({ ...query, date: '2026-11-01', modes: ['train'] });
  if (outside.journeys.length || outside.providers[0]?.status !== 'unavailable') throw new Error('An out-of-coverage date returned timetable results.');
  const uncovered = await plan({ ...query, from: { name: 'Tokyo', lat: 35.6762, lon: 139.6503, iata: 'TYO' }, modes: ['train'] });
  if (uncovered.journeys.length || uncovered.providers[0]?.status !== 'empty') throw new Error('An uncovered origin returned timetable results.');
  return { url: origin.origin, verifiedAssets: checked.length, health: true, railJourneys: rail.length, railFares: 'unknown', fastestMinutes: Math.min(...rail.map((journey) => journey.durationMinutes)),
    providers: result.providers.map(({ id, status }) => ({ id, status })), outOfCoverage: outside.providers[0].status, uncoveredOrigin: uncovered.providers[0].status,
    attribution: rail[0].sources[0].attribution, retrievedAt: rail[0].source.fetchedAt, internalCredentialFieldsExposed: false };
}

async function verifyWithTail({ url, tailUrl }) {
  if (typeof tailUrl !== 'string' || !tailUrl.startsWith('wss://')) throw new Error('A valid temporary tail URL is required.');
  const events = [];
  const socket = new WebSocket(tailUrl, 'trace-v1');
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', ({ data }) => {
    try {
      const event = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
      events.push({ outcome: event.outcome, cpuTime: event.cpuTime ?? event.cpu_time_ms ?? null, wallTime: event.wallTime ?? event.wall_time_ms ?? null,
        exceptionCount: Array.isArray(event.exceptions) ? event.exceptions.length : 0,
        timingFields: Object.keys(event).filter((key) => /cpu|wall|duration/i.test(key)) });
    } catch { /* Ignore connection control frames. */ }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tail connection timed out.')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); socket.send(JSON.stringify({ debug: false })); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Tail connection failed.')); }, { once: true });
    });
    const verified = await verifyDeployment(url);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return { ...verified, traceEvents: events.slice(0, 30) };
  } finally { socket.close(); }
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'manifest') return { manifest: readPackage().manifest };
  if (mode === 'upload-assets') return { jwt: await uploadAssets(await readInputLine()) };
  if (mode === 'verify') return verifyDeployment(process.argv[3]);
  if (mode === 'verify-tail') return verifyWithTail(await readInputLine());
  if (mode === 'connector-package') return workerPackage({ bundled: process.argv.includes('--bundled-assets') });
  if (mode === 'connector-package-chunk') {
    // Bounded transport for automation tools with a one-megabyte output ceiling.
    const offset = Number(process.argv[3] || 0), length = Number(process.argv[4] || 400_000);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 400_000) throw new Error('Invalid package chunk range.');
    const text = JSON.stringify(workerPackage({ bundled: process.argv.includes('--bundled-assets') }));
    return { offset, total: text.length, chunk: text.slice(offset, offset + length) };
  }
  return deploy({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // A diagnostic tail can retain a WebSocket close handshake. All requested
  // operations have finished here; flush the sole result before releasing it.
  main().then((result) => process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0)))
    .catch((error) => process.stderr.write(error.message + '\n', () => process.exit(1)));
}
