/** Standard Cloudflare Static Assets deploy, with connector-compatible pieces.
 * Fully automated CI: npm run deploy (requires Cloudflare credentials in the environment).
 * Connector: `manifest` emits public manifest; create upload session with the connector;
 * `upload-assets` reads one JSON line {accountId,jwt,buckets} from stdin, writes one
 * JSON line {jwt} for the caller to capture (a short-lived completion credential).
 * `connector-package` emits code + metadata WITHOUT credentials for tool orchestration.
 * `verify URL [YYYY-MM-DD]` checks tomorrow in UTC unless a fixture date is supplied.
 * `verify-tail` accepts {url,tailUrl,date?}; its date follows the same convention.
 * Never save either JWT output to a repository file or display it to the traveler.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetHash, ROOT, OUT } from './build-cloudflare.mjs';
import { inside, sha256, sourceFingerprint } from './cloudflare-package.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const accountPattern = /^[a-f0-9]{32}$/;
const scriptPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function readPackage({ root = ROOT, out = join(root, 'worker', '.build') } = {}) {
  const summary = JSON.parse(readFileSync(join(out, 'package-summary.json'), 'utf8'));
  if (summary.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(summary.buildId || '')) throw new Error('Rebuild the deployment package using npm run build:cloudflare.');
  if (!scriptPattern.test(summary.name)) throw new Error('Invalid Worker name.');
  if (sourceFingerprint(root) !== summary.sourceFingerprint) throw new Error('Deployment sources changed after packaging. Run npm run build:cloudflare again.');
  const required = ['worker.mjs', 'asset-files.json', 'asset-manifest.json', 'worker-metadata.json', 'headers.json'];
  if (summary.bundled) required.push('worker-bundled.mjs', 'worker-bundled-metadata.json', 'wrangler-bundled.json');
  if (!summary.integrity || required.some((path) => !summary.integrity[path])) throw new Error('Incomplete deployment package.');
  for (const [path, hash] of Object.entries(summary.integrity)) {
    if (sha256(readFileSync(inside(out, path))) !== hash) throw new Error('A deployment package file changed after the build.');
  }
  const files = JSON.parse(readFileSync(join(out, 'asset-files.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(out, 'asset-manifest.json'), 'utf8'));
  if (!Array.isArray(files) || files.length !== summary.assetCount || Object.keys(manifest).length !== files.length) throw new Error('Asset manifest does not match the package.');
  const paths = new Set();
  for (const file of files) {
    if (!file.path?.startsWith('/') || paths.has(file.path) || file.packagePath !== 'assets/' + file.path.slice(1)) throw new Error('Invalid asset package path.');
    paths.add(file.path);
    const bytes = readFileSync(inside(out, file.packagePath));
    if (bytes.length !== file.size || assetHash(bytes, file.path) !== file.hash || sha256(bytes) !== file.sha256
      || manifest[file.path]?.hash !== file.hash || manifest[file.path]?.size !== file.size) throw new Error('An asset changed after packaging. Build a new package before deploying.');
    file.localPath = inside(out, file.packagePath);
  }
  return { summary, files, manifest, root, out, headers: JSON.parse(readFileSync(join(out, 'headers.json'), 'utf8')) };
}

async function api(path, options, credential) {
  const response = await fetch(API + path, { ...options, headers: { authorization: `Bearer ${credential}`, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  let body;
  try { body = await response.json(); } catch {
    const error = new Error(`Cloudflare returned an unreadable response: HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok || !body?.success) {
    // Cloudflare messages can reflect request data; only stable error codes leave this helper.
    const codes = Array.isArray(body?.errors) ? body.errors.map((entry) => entry.code).filter((code) => typeof code === 'number').join(',') : '';
    const error = new Error(`Cloudflare request failed: HTTP ${response.status}${codes ? ` (codes ${codes})` : ''}.`);
    error.status = response.status;
    throw error;
  }
  return body.result;
}

export async function uploadAssets(session, fetchApi = api, packaged = readPackage()) {
  if (!accountPattern.test(session?.accountId || '') || typeof session?.jwt !== 'string' || !session.jwt || !Array.isArray(session.buckets)) throw new Error('A valid account and asset-upload session are required.');
  const { files } = packaged;
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

export function workerPackage({ bundled = false, packaged = readPackage() } = {}) {
  const { summary, out } = packaged;
  if (bundled && !summary.bundled) throw new Error('This build does not include bundled assets. Rebuild with --bundled-assets.');
  const metadata = JSON.parse(readFileSync(join(out, bundled ? 'worker-bundled-metadata.json' : 'worker-metadata.json'), 'utf8'));
  return { name: summary.name, metadata, code: readFileSync(join(out, bundled ? 'worker-bundled.mjs' : 'worker.mjs'), 'utf8') };
}

function saveReceipt(path, receipt) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n');
}

export async function deploy({ accountId, token, receiptPath = process.env.CLOUDFLARE_DEPLOYMENT_RECEIPT || join(OUT, 'deployment-receipt.json'), fetchApi = api, verify = verifyDeployment, packaged = readPackage(), writeReceipt = saveReceipt }) {
  if (!accountPattern.test(accountId || '') || !token) throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for CI deployment.');
  const { summary, manifest } = packaged;
  const endpoint = `/accounts/${accountId}/workers/scripts/${summary.name}`;
  let previousVersions = [];
  try {
    const current = await fetchApi(`${endpoint}/deployments`, { method: 'GET' }, token);
    if (!Array.isArray(current?.deployments)) throw new Error('Cloudflare did not return deployment history; publishing was stopped.');
    previousVersions = current.deployments?.[0]?.versions || [];
  } catch (error) { if (error.status !== 404) throw error; }
  const subdomain = await fetchApi(`/accounts/${accountId}/workers/subdomain`, { method: 'GET' }, token);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(subdomain?.subdomain || '')) throw new Error('Cloudflare returned an invalid workers.dev subdomain.');
  const url = `https://${summary.name}.${subdomain.subdomain}.workers.dev`;
  const receipt = { schemaVersion: 1, name: summary.name, accountId, url, buildId: summary.buildId, previousVersions, startedAt: new Date().toISOString(), status: 'prepared' };
  // This nonsecret recovery record exists before the first production mutation.
  writeReceipt(receiptPath, receipt);
  try {
    const session = await fetchApi(`${endpoint}/assets-upload-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest }) }, token);
    const jwt = await uploadAssets({ ...session, accountId }, fetchApi, packaged);
    readPackage({ root: packaged.root, out: packaged.out });
    const worker = workerPackage({ packaged });
    worker.metadata.assets.jwt = jwt;
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(worker.metadata)], { type: 'application/json' }));
    form.append('worker.mjs', new Blob([worker.code], { type: 'application/javascript+module' }), 'worker.mjs');
    receipt.status = 'publishing'; writeReceipt(receiptPath, receipt);
    await fetchApi(endpoint, { method: 'PUT', body: form }, token);
    await fetchApi(`${endpoint}/subdomain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, previews_enabled: false }) }, token);
    receipt.status = 'verifying'; writeReceipt(receiptPath, receipt);
    let verification;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { verification = await verify(url, undefined, { packaged }); break; }
      catch (error) { if (attempt === 2) throw error; await new Promise((done) => setTimeout(done, 3000)); }
    }
    const current = await fetchApi(`${endpoint}/deployments`, { method: 'GET' }, token);
    const deployment = current.deployments?.[0];
    if (!deployment?.versions?.length) throw new Error('Cloudflare did not return the active deployment versions.');
    Object.assign(receipt, { status: 'verified', deploymentId: deployment.id, versions: deployment.versions, verification, completedAt: new Date().toISOString() });
    writeReceipt(receiptPath, receipt);
    return receipt;
  } catch (error) {
    receipt.failedStage = receipt.status; receipt.status = 'failed'; writeReceipt(receiptPath, receipt);
    throw new Error(`${error.message} Recovery receipt: ${receiptPath}. ${previousVersions.length ? 'To restore the previous deployment, run npm run rollback:cloudflare -- followed by the receipt path.' : 'No previous deployment exists; fix and redeploy the initial release.'}`);
  }
}

export async function rollback(receipt, { accountId, token, fetchApi = api } = {}) {
  if (!accountPattern.test(accountId || '') || !token || receipt?.accountId !== accountId || !scriptPattern.test(receipt?.name || '')) throw new Error('Valid credentials and a matching deployment receipt are required.');
  const versions = receipt.previousVersions;
  if (!Array.isArray(versions) || !versions.length || versions.some((version) => !/^[a-f0-9-]{36}$/.test(version.version_id || '') || !Number.isFinite(version.percentage) || version.percentage <= 0)
    || Math.abs(versions.reduce((sum, version) => sum + version.percentage, 0) - 100) > 0.001) throw new Error('The receipt has no valid previous deployment to restore.');
  const endpoint = `/accounts/${accountId}/workers/scripts/${receipt.name}/deployments`;
  const result = await fetchApi(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'percentage', versions: versions.map(({ version_id, percentage }) => ({ version_id, percentage })), annotations: { 'workers/message': 'Restore deployment recorded before Travel Freely release' } }) }, token);
  const current = await fetchApi(endpoint, { method: 'GET' }, token);
  const active = current.deployments?.[0];
  if (!active || active.id !== result.id || active.versions?.length !== versions.length
    || versions.some((version) => !active.versions.some((entry) => entry.version_id === version.version_id && entry.percentage === version.percentage))) throw new Error('Rollback was requested but the active deployment could not be confirmed. Inspect Cloudflare deployments before taking another action.');
  return { name: receipt.name, deploymentId: result.id, restoredVersions: versions, status: 'restored' };
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
    try { return JSON.parse(value.trim()); } catch { throw new Error('Deployment session input must be valid JSON.'); }
  } finally {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    if (typeof process.stdin.unref === 'function') process.stdin.unref();
  }
}

const DAY_MS = 86_400_000;

function isoDateEpoch(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value ? epoch : null;
}

export function diagnosticDate(value, now = new Date()) {
  const today = isoDateEpoch(now.toISOString().slice(0, 10));
  const epoch = value === undefined ? today + DAY_MS : isoDateEpoch(value);
  if (epoch === null || epoch < today || epoch > today + 365 * DAY_MS) throw new Error('Use a real diagnostic date from today through the next 365 days.');
  return new Date(epoch).toISOString().slice(0, 10);
}

export function outOfCoverageDate(calendar, now = new Date()) {
  const today = isoDateEpoch(now.toISOString().slice(0, 10));
  const latest = today + 365 * DAY_MS;
  const start = isoDateEpoch(calendar?.from);
  const days = calendar?.days;
  if (start === null || !Number.isInteger(days) || days < 1) return new Date(latest).toISOString().slice(0, 10);
  // Calendar end is exclusive. Either boundary can be used if the API accepts it.
  const end = start + days * DAY_MS;
  const outside = [Math.max(today, end), Math.min(latest, start - DAY_MS)]
    .find((epoch) => epoch >= today && epoch <= latest && (epoch < start || epoch >= end));
  return outside === undefined ? null : new Date(outside).toISOString().slice(0, 10);
}

function assertUnpricedRail(journeys, description) {
  const rail = Array.isArray(journeys) ? journeys.filter((journey) => journey.provider === 'rail') : [];
  if (!rail.length || rail.some((journey) => journey.price !== null || !Number.isFinite(journey.durationMinutes) || journey.durationMinutes <= 0
    || !Number.isFinite(Date.parse(journey.departure)) || !Number.isFinite(Date.parse(journey.arrival))
    || !journey.from?.name || !journey.to?.name || !Array.isArray(journey.legs) || !journey.legs.length)) {
    throw new Error(`Expected valid unpriced published timetable journeys: ${description}.`);
  }
  return rail;
}

export async function verifyDeployment(url, date, { packaged = readPackage(), fetcher = fetch, allowLocal = false } = {}) {
  const origin = new URL(url);
  const publicOrigin = origin.protocol === 'https:' && /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname);
  const localOrigin = allowLocal && origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname);
  if ((!publicOrigin && !localOrigin) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Verify a public HTTPS workers.dev origin.');
  const queryDate = diagnosticDate(date);
  const { files, summary, headers: rules } = packaged;
  const request = async (path, options = {}) => {
    let address = new URL(path, origin);
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await fetcher(address, { ...options, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location || (options.method && options.method !== 'GET')) throw new Error('Unexpected public API redirect.');
      address = new URL(location, address);
      if (address.origin !== origin.origin) throw new Error('Public asset redirected to a different origin.');
    }
    throw new Error('Too many public asset redirects.');
  };
  const staticHeaders = (response, path) => {
    const expected = new Map();
    for (const rule of rules) {
      const [prefix, suffix] = rule.path.split('*');
      if (rule.path.includes('*') ? path.startsWith(prefix) && path.endsWith(suffix) : path === rule.path) {
        for (const [name, value] of Object.entries(rule.headers)) expected.set(name, expected.has(name) ? `${expected.get(name)}, ${value}` : value);
      }
    }
    for (const [name, value] of expected) if (response.headers.get(name) !== value) throw new Error(`Incorrect public security or caching header: ${name} on ${path}.`);
  };
  const apiHeaders = (response) => {
    for (const [name, value] of Object.entries({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' })) {
      if (response.headers.get(name) !== value) throw new Error(`Incorrect public API header: ${name}.`);
    }
    if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error('The public API returned an incorrect content type.');
  };
  const checked = [];
  let nextAsset = 0;
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, async () => {
    while (nextAsset < files.length) {
    const file = files[nextAsset++];
    const response = await request(file.path);
    if (!response.ok) throw new Error(`Public asset returned HTTP ${response.status}: ${file.path}`);
    if (!response.headers.get('content-type')?.startsWith(file.mime.split(';')[0])) throw new Error(`Incorrect public MIME type: ${file.path}`);
    staticHeaders(response, file.path);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (assetHash(bytes, file.path) !== file.hash) throw new Error(`Public asset differs from the approved build: ${file.path}`);
    checked.push(file.path);
    }
  }));
  const spa = await request('/trip/verification');
  staticHeaders(spa, '/trip/verification');
  const index = files.find((file) => file.path === '/index.html');
  if (!spa.ok || !index || assetHash(Buffer.from(await spa.arrayBuffer()), index.path) !== index.hash) throw new Error('The public application route does not serve this build.');
  const healthResponse = await request('/api/health');
  apiHeaders(healthResponse);
  const health = await healthResponse.json();
  if (!healthResponse.ok || health.ok !== true || health.service !== 'Travel Freely' || health.buildId !== summary.buildId
    || !health.providers?.some((provider) => provider.id === 'rail' && provider.configured)) throw new Error('Public API health or deployed build identity failed.');
  for (const [path, options, status] of [
    ['/api/unknown', {}, 404], ['/api/plan', {}, 405], ['/api/health', { method: 'POST' }, 405],
    ['/api/plan', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.invalid' }, body: '{}' }, 403],
  ]) {
    const response = await request(path, options);
    apiHeaders(response);
    if (response.status !== status || !(await response.json()).error) throw new Error('Public API route or request validation failed.');
  }
  // Train-only diagnostics never trigger a configured paid flight provider.
  const query = { from: { name: 'Berlin', lat: 52.52, lon: 13.405, iata: 'BER' }, to: { name: 'Munich', lat: 48.137, lon: 11.575, iata: 'MUC' }, date: queryDate, adults: 1, cabin: 'economy', modes: ['train'] };
  const plan = async (body) => {
    const response = await request('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    apiHeaders(response);
    const result = await response.json();
    if (!response.ok) throw new Error(`Public journey search failed: HTTP ${response.status}.`);
    if (/x-api-key|sessionToken|SKYSCANNER_API_KEY|Bearer /i.test(JSON.stringify(result))) throw new Error('An internal credential field appeared in a public response.');
    return result;
  };
  const result = await plan(query);
  const rail = assertUnpricedRail(result.journeys, 'Berlin to Munich');
  const outsideDate = outOfCoverageDate(result.providers.find(({ id }) => id === 'rail')?.calendar);
  let outsideStatus = 'skipped: published calendar covers the API date range';
  if (outsideDate) {
    const outside = await plan({ ...query, date: outsideDate, modes: ['train'] });
    outsideStatus = outside.providers.find(({ id }) => id === 'rail')?.status;
    if (outside.journeys.length || outsideStatus !== 'unavailable') throw new Error('An out-of-coverage date returned timetable results.');
  }
  const uncovered = await plan({ ...query, from: { name: 'Tokyo', lat: 35.6762, lon: 139.6503, iata: 'TYO' }, modes: ['train'] });
  if (uncovered.journeys.length || uncovered.providers[0]?.status !== 'empty') throw new Error('An uncovered origin returned timetable results.');
  const streamed = await request('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify(query) });
  if (!streamed.ok || !streamed.headers.get('content-type')?.startsWith('application/x-ndjson') || streamed.headers.get('cache-control') !== 'no-store') throw new Error('Public streaming search failed.');
  const events = (await streamed.text()).trim().split('\n').map((line) => JSON.parse(line));
  if (events[0]?.type !== 'start' || events.at(-1)?.type !== 'complete') throw new Error('Public streaming search did not complete.');
  assertUnpricedRail(events.find((event) => event.type === 'provider' && event.provider?.id === 'rail')?.journeys, 'streamed Berlin to Munich');
  return { url: origin.origin, date: queryDate, buildId: health.buildId, verifiedAssets: checked.length, health: true, streaming: true, routeValidation: true, securityHeaders: true, railJourneys: rail.length, railFares: 'unknown', fastestMinutes: Math.min(...rail.map((journey) => journey.durationMinutes)),
    providers: result.providers.map(({ id, status }) => ({ id, status })), outOfCoverage: outsideStatus, outOfCoverageDate: outsideDate, uncoveredOrigin: uncovered.providers[0].status,
    attribution: rail[0].sources[0].attribution, retrievedAt: rail[0].source.fetchedAt, internalCredentialFieldsExposed: false };
}

async function verifyWithTail({ url, tailUrl, date }) {
  if (typeof tailUrl !== 'string' || !tailUrl.startsWith('wss://')) throw new Error('A valid temporary tail URL is required.');
  const queryDate = diagnosticDate(date);
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
    // Hit real route searches first: health must not warm the new isolate before
    // the cold-request measurement. No synthetic fare fixtures enter this path.
    const cities = {
      Berlin: { name: 'Berlin', lat: 52.52, lon: 13.405, iata: 'BER' },
      Munich: { name: 'Munich', lat: 48.137, lon: 11.575, iata: 'MUC' },
      Hamburg: { name: 'Hamburg', lat: 53.5511, lon: 9.9937, iata: 'HAM' },
      Frankfurt: { name: 'Frankfurt', lat: 50.1109, lon: 8.6821, iata: 'FRA' },
    };
    const measuredRoutes = [];
    for (const [from, to] of [['Berlin', 'Munich'], ['Berlin', 'Munich'], ['Munich', 'Berlin'], ['Hamburg', 'Frankfurt']]) {
      const response = await fetch(new URL('/api/plan', url), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: cities[from], to: cities[to], date: queryDate, adults: 1, cabin: 'economy', modes: ['train'] }), signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      if (!response.ok) throw new Error(`Live measured route failed: ${from} to ${to}.`);
      const rail = assertUnpricedRail(body.journeys, `${from} to ${to}`);
      measuredRoutes.push({ from, to, journeys: rail.length, fastestMinutes: Math.min(...rail.map((journey) => journey.durationMinutes)) });
    }
    const verified = await verifyDeployment(url, queryDate);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return { ...verified, measuredRoutes, traceEvents: events.slice(0, 30) };
  } finally { socket.close(); }
}

export function parseCommand(args) {
  const [mode = 'help', ...rest] = args;
  if (['help', '--help', '-h'].includes(mode) && !rest.length) return { mode: 'help', args: [] };
  const exact = { deploy: 0, manifest: 0, 'upload-assets': 0, 'verify-tail': 0, rollback: 1 };
  if (Object.hasOwn(exact, mode) && rest.length === exact[mode]) return { mode, args: rest };
  if (mode === 'verify' && rest.length >= 1 && rest.length <= 2 && !rest.some((arg) => arg.startsWith('--'))) return { mode, args: rest };
  if (mode === 'connector-package' && (rest.length === 0 || rest.length === 1 && rest[0] === '--bundled-assets')) return { mode, args: rest };
  if (mode === 'connector-package-chunk' && rest.length >= 2 && rest.length <= 3 && /^\d+$/.test(rest[0]) && /^\d+$/.test(rest[1]) && (!rest[2] || rest[2] === '--bundled-assets')) return { mode, args: rest };
  throw new Error('Unknown deployment command or arguments. Run node scripts/deploy-cloudflare.mjs help.');
}

export async function main(argv = process.argv.slice(2)) {
  const { mode, args } = parseCommand(argv);
  if (mode === 'help') return { usage: 'deploy | verify URL [YYYY-MM-DD] | rollback RECEIPT | manifest | upload-assets | connector-package [--bundled-assets] | connector-package-chunk OFFSET LENGTH [--bundled-assets] | verify-tail', note: 'No deployment runs without the explicit deploy command. Prefer npm run deploy for required tests and packaging.' };
  if (mode === 'manifest') return { manifest: readPackage().manifest };
  if (mode === 'upload-assets') return { jwt: await uploadAssets(await readInputLine()) };
  if (mode === 'verify') return verifyDeployment(args[0], args[1]);
  if (mode === 'verify-tail') return verifyWithTail(await readInputLine());
  if (mode === 'connector-package') return workerPackage({ bundled: args.includes('--bundled-assets') });
  if (mode === 'connector-package-chunk') {
    // Bounded transport for automation tools with a one-megabyte output ceiling.
    const offset = Number(args[0]), length = Number(args[1]);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 400_000) throw new Error('Invalid package chunk range.');
    const text = JSON.stringify(workerPackage({ bundled: args.includes('--bundled-assets') }));
    return { offset, total: text.length, chunk: text.slice(offset, offset + length) };
  }
  const credentials = { accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN };
  if (mode === 'rollback') return rollback(JSON.parse(readFileSync(resolve(args[0]), 'utf8')), credentials);
  if (mode === 'deploy') return deploy(credentials);
  throw new Error('Unsupported deployment operation.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // A diagnostic tail can retain a WebSocket close handshake. All requested
  // operations have finished here; flush the sole result before releasing it.
  main().then((result) => process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0)))
    .catch((error) => process.stderr.write(error.message + '\n', () => process.exit(1)));
}
