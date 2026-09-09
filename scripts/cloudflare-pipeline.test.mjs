import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCloudflare } from './build-cloudflare.mjs';
import { parseHeaders, serveBundled, readConfiguration, inside } from './cloudflare-package.mjs';
import { readPackage, workerPackage, uploadAssets, parseCommand, main, deploy, rollback, verifyDeployment } from './deploy-cloudflare.mjs';

const accountId = 'a'.repeat(32);
const previousVersion = '11111111-1111-4111-8111-111111111111';
const deployedVersion = '22222222-2222-4222-8222-222222222222';
const baselineHeaders = "/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src 'self'\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'travel-freely-pipeline-'));
  t.after(() => {
    // This guard precedes recursive cleanup on Windows and other platforms.
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('travel-freely-pipeline-')) throw new Error('Unsafe test cleanup path.');
    rmSync(root, { recursive: true, force: true });
  });
  for (const path of ['src/data', 'worker', 'dist/assets']) mkdirSync(join(root, path), { recursive: true });
  const now = new Date(), today = now.toISOString().slice(0, 10);
  writeFileSync(join(root, 'src/data/edge-network.json'), JSON.stringify({ generatedAt: now.toISOString(), calendarEpoch: Number(today.replaceAll('-', '')), calendarDays: 10, sources: [{ retrievedAt: now.toISOString() }] }));
  writeFileSync(join(root, 'worker/index.js'), 'export default { fetch() { return new Response("fixture"); } };');
  const config = { name: 'travel-freely', main: 'worker/index.js', compatibility_date: '2026-09-09', compatibility_flags: ['enable_request_signal'], keep_vars: true,
    assets: { directory: './dist', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
    ratelimits: [{ name: 'SEARCH_RATE_LIMITER', namespace_id: '1001', simple: { limit: 20, period: 60 } }], vars: { DISPLAY_NAME: 'Travel Freely', SETTINGS: { enabled: true } }, observability: { enabled: false } };
  writeFileSync(join(root, 'wrangler.jsonc'), '// Valid JSONC comments must survive packaging.\n' + JSON.stringify(config, null, 2).replace(/\n}$/, ',\n}'));
  writeFileSync(join(root, 'dist/index.html'), '<html><script type="module" src="/assets/app.js"></script></html>');
  writeFileSync(join(root, 'dist/assets/app.js'), 'console.log("public");');
  writeFileSync(join(root, 'dist/_headers'), baselineHeaders);
  writeFileSync(join(root, 'dist/.env'), 'NEVER_PUBLIC=fixture');
  writeFileSync(join(root, 'dist/assets/app.js.map'), '{"fixture":"not-public"}');
  return { root, config, out: join(root, 'worker/.build') };
}

test('deployment CLI requires an explicit known command and rejects extra arguments', async () => {
  assert.equal(parseCommand([]).mode, 'help');
  assert.equal((await main([])).note.includes('explicit deploy'), true);
  for (const args of [['deply'], ['--dry-run'], ['deploy', '--help'], ['manifest', 'extra'], ['verify'], ['connector-package', '--unknown'], ['rollback'], ['connector-package-chunk', 'no', '10']]) assert.throws(() => parseCommand(args), /Unknown/);
  assert.equal(parseCommand(['deploy']).mode, 'deploy');
  assert.equal(parseCommand(['connector-package-chunk', '0', '400000', '--bundled-assets']).mode, 'connector-package-chunk');
});

test('configuration parses JSONC and refuses unsupported binding or logging changes', (t) => {
  const { root, config } = fixture(t);
  assert.deepEqual(readConfiguration(root).compatibility_flags, ['enable_request_signal']);
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ ...config, kv_namespaces: [{ binding: 'KV', id: 'a'.repeat(32) }] }));
  assert.throws(() => readConfiguration(root), /Unsupported Wrangler/);
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ ...config, vars: { SKYSCANNER_API_KEY: 'fixture' } }));
  assert.throws(() => readConfiguration(root), /credentials/);
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ ...config, observability: { enabled: true } }));
  assert.throws(() => readConfiguration(root), /logging/);
});

test('package freezes public files and preserves bindings, flags, and headers in both forms', async (t) => {
  const { root } = fixture(t);
  const summary = await buildCloudflare({ root, frontend: false, bundledAssets: true });
  assert.equal(summary.assetCount, 2);
  assert.equal(summary.standard.gzipBytes < summary.standard.limitBytes, true);
  assert.equal(summary.bundled.gzipBytes < summary.bundled.limitBytes, true);
  writeFileSync(join(root, 'dist/_headers'), '/*\n  X-Frame-Options: SAMEORIGIN\n');
  writeFileSync(join(root, 'dist/assets/app.js'), 'changed after packaging');
  const packaged = readPackage({ root });
  assert.equal(packaged.files.some((file) => file.path.includes('.env') || file.path.endsWith('.map')), false);
  for (const bundled of [false, true]) {
    const worker = workerPackage({ bundled, packaged });
    assert.deepEqual(worker.metadata.compatibility_flags, ['enable_request_signal']);
    assert.deepEqual(worker.metadata.keep_bindings, ['secret_text', 'secret_key', 'plain_text', 'json']);
    assert.equal(worker.metadata.bindings.find((item) => item.type === 'ratelimit').simple.limit, 20);
    assert.equal(worker.metadata.bindings.find((item) => item.name === 'BUILD_ID').text, summary.buildId);
    assert.deepEqual(worker.metadata.bindings.find((item) => item.name === 'SETTINGS').json, { enabled: true });
    assert.equal(worker.metadata.bindings.some((item) => item.type === 'assets'), !bundled);
    if (!bundled) assert.equal(worker.metadata.assets.config._headers, baselineHeaders);
  }
  assert.equal(readFileSync(packaged.files.find((file) => file.path.endsWith('app.js')).localPath, 'utf8'), 'console.log("public");');
});

test('package rejects edited assets and metadata, source drift, and stale fallback output', async (t) => {
  const { root, out } = fixture(t);
  await buildCloudflare({ root, frontend: false });
  let packaged = readPackage({ root });
  assert.throws(() => workerPackage({ bundled: true, packaged }), /does not include/);
  writeFileSync(join(out, 'assets/assets/app.js'), 'tampered');
  assert.throws(() => readPackage({ root }), /asset changed/);
  await buildCloudflare({ root, frontend: false });
  writeFileSync(join(out, 'worker-metadata.json'), '{}');
  assert.throws(() => readPackage({ root }), /package file changed/);
  await buildCloudflare({ root, frontend: false });
  writeFileSync(join(root, 'worker/index.js'), 'export default {};');
  assert.throws(() => readPackage({ root }), /sources changed/);
  assert.throws(() => inside(out, '../private.txt'), /escaped/);
});

test('build requires a fresh explicit timetable and never silently fetches one', async (t) => {
  const { root } = fixture(t);
  const path = join(root, 'src/data/edge-network.json');
  const stale = JSON.parse(readFileSync(path, 'utf8'));
  stale.sources[0].retrievedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  writeFileSync(path, JSON.stringify(stale));
  await assert.rejects(buildCloudflare({ root, frontend: false }), /stale/);
  rmSync(path);
  await assert.rejects(buildCloudflare({ root, frontend: false }), /npm run data:edge/);
});

test('portable static responses apply the same headers on GET, HEAD, 304 and errors', async () => {
  const rules = parseHeaders(baselineHeaders);
  const assets = { '/index.html': { body: '<html>fixture</html>', mime: 'text/html', etag: '"index"' }, '/assets/app.js': { body: 'fixture()', mime: 'text/javascript', etag: '"app"' } };
  for (const [path, init, status] of [['/', {}, 200], ['/trip/berlin', {}, 200], ['/assets/app.js', { method: 'HEAD' }, 200], ['/assets/app.js', { headers: { 'if-none-match': 'W/"app", "older"' } }, 304], ['/assets/missing.js', {}, 404], ['/.env', {}, 404], ['/%00', {}, 404], ['/', { method: 'POST' }, 405]]) {
    const response = serveBundled(new Request('https://test.example' + path, init), assets, rules);
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'self'", path);
    if (path.startsWith('/assets/')) assert.match(response.headers.get('cache-control'), /immutable/);
    if (status === 304 || init.method === 'HEAD') assert.equal(await response.text(), '');
  }
  assert.throws(() => parseHeaders('/api/*/*\n  Thing: value'), /Unsupported/);
});

test('asset upload validates unknown buckets and uses only frozen bytes', async (t) => {
  const { root } = fixture(t);
  await buildCloudflare({ root, frontend: false });
  const packaged = readPackage({ root });
  const session = { accountId, jwt: 'temporary-test-token', buckets: [[packaged.files[0].hash]] };
  let uploaded = 0;
  const fetchApi = async (path, options, credential) => {
    assert.match(path, /assets\/upload\?base64=true/);
    assert.equal(credential, session.jwt);
    const blob = options.body.get(packaged.files[0].hash);
    assert.equal(await blob.text(), readFileSync(packaged.files[0].localPath).toString('base64'));
    uploaded++;
    return { jwt: 'completed-test-token' };
  };
  assert.equal(await uploadAssets(session, fetchApi, packaged), 'completed-test-token');
  assert.equal(await uploadAssets({ ...session, buckets: [] }, fetchApi, packaged), session.jwt);
  assert.equal(uploaded, 1);
  await assert.rejects(uploadAssets({ ...session, buckets: [['unknown']] }, fetchApi, packaged), /unknown asset/);
});

test('deploy records recovery before mutation and obtains version IDs from deployments', async (t) => {
  const { root } = fixture(t);
  await buildCloudflare({ root, frontend: false });
  const packaged = readPackage({ root });
  const receipts = [], calls = [];
  let published = false;
  const fetchApi = async (path, options) => {
    calls.push([path, options.method]);
    if (path.endsWith('/deployments')) return { deployments: [{ id: published ? 'new-deployment' : 'old-deployment', versions: [{ version_id: published ? deployedVersion : previousVersion, percentage: 100 }] }] };
    if (path.endsWith('/workers/subdomain')) return { subdomain: 'account' };
    if (path.endsWith('/assets-upload-session')) { assert.equal(receipts[0].status, 'prepared'); return { jwt: 'upload', buckets: [] }; }
    if (options.method === 'PUT') { published = true; return { id: 'script-id-is-not-a-version' }; }
    if (path.endsWith('/subdomain')) return {};
    throw new Error('Unexpected test API call');
  };
  const receipt = await deploy({ accountId, token: 'fixture', packaged, fetchApi, verify: async (url) => ({ url, verifiedAssets: 2 }), writeReceipt: (_, value) => receipts.push(structuredClone(value)) });
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.versions[0].version_id, deployedVersion);
  assert.equal(receipt.previousVersions[0].version_id, previousVersion);
  assert.deepEqual(receipts.map(({ status }) => status), ['prepared', 'publishing', 'verifying', 'verified']);
  assert.equal(JSON.stringify(receipts).includes('upload'), false);
});

test('a preflight failure prevents upload and a publish failure retains actionable recovery', async (t) => {
  const { root } = fixture(t);
  await buildCloudflare({ root, frontend: false });
  const packaged = readPackage({ root });
  let requests = 0;
  await assert.rejects(deploy({ accountId, token: 'fixture', packaged, fetchApi: async () => { requests++; const error = new Error('HTTP 403'); error.status = 403; throw error; } }), /403/);
  assert.equal(requests, 1);
  const receipts = [];
  await assert.rejects(deploy({ accountId, token: 'fixture', packaged, writeReceipt: (_, value) => receipts.push(structuredClone(value)), fetchApi: async (path, options) => {
    if (path.endsWith('/deployments')) return { deployments: [{ versions: [{ version_id: previousVersion, percentage: 100 }] }] };
    if (path.endsWith('/workers/subdomain')) return { subdomain: 'account' };
    if (path.endsWith('/assets-upload-session')) return { jwt: 'test', buckets: [] };
    if (options.method === 'PUT') throw new Error('HTTP 503');
    throw new Error('Unexpected request');
  } }), /rollback:cloudflare/);
  assert.equal(receipts.at(-1).status, 'failed');
  assert.equal(receipts.at(-1).failedStage, 'publishing');
  assert.equal(receipts.at(-1).previousVersions[0].version_id, previousVersion);
});

test('rollback only accepts matching account receipts and restores their exact versions', async () => {
  const receipt = { accountId, name: 'travel-freely', previousVersions: [{ version_id: previousVersion, percentage: 100 }] };
  let calls = 0;
  const fetchApi = async (path, options) => {
    calls++;
    assert.match(path, /travel-freely\/deployments$/);
    if (options.method === 'GET') return { deployments: [{ id: 'rollback-id', versions: receipt.previousVersions }] };
    assert.deepEqual(JSON.parse(options.body).versions, receipt.previousVersions);
    return { id: 'rollback-id' };
  };
  await assert.rejects(rollback({ ...receipt, accountId: 'b'.repeat(32) }, { accountId, token: 'fixture', fetchApi }), /matching/);
  await assert.rejects(rollback({ ...receipt, previousVersions: [] }, { accountId, token: 'fixture', fetchApi }), /valid previous/);
  assert.equal((await rollback(receipt, { accountId, token: 'fixture', fetchApi })).status, 'restored');
  assert.equal(calls, 2);
});

test('public verification checks bytes, build ID, headers, routes, and complete streaming rail', async (t) => {
  const { root } = fixture(t);
  await buildCloudflare({ root, frontend: false });
  const packaged = readPackage({ root });
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10);
  const rail = { provider: 'rail', price: null, durationMinutes: 240, departure: `${tomorrow}T08:00:00Z`, arrival: `${tomorrow}T12:00:00Z`, from: { name: 'Berlin' }, to: { name: 'Munich' }, legs: [{ mode: 'train' }], sources: [{ attribution: 'Fixture published timetable' }], source: { fetchedAt: new Date().toISOString() } };
  const apiHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };
  let wrongBuild = false, brokenStream = false;
  const fetcher = async (url, options) => {
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      const file = packaged.files.find((item) => item.path === path) || packaged.files.find((item) => item.path === '/index.html');
      return new Response(readFileSync(file.localPath), { headers: { 'content-type': file.mime, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'", ...(path.startsWith('/assets/') ? { 'cache-control': 'public, max-age=31536000, immutable' } : {}) } });
    }
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: apiHeaders });
    if (path === '/api/unknown') return json({ error: 'not_found' }, 404);
    if (path === '/api/health') return options.method === 'POST' ? json({ error: 'method_not_allowed' }, 405) : json({ ok: true, service: 'Travel Freely', buildId: wrongBuild ? 'old' : packaged.summary.buildId, providers: [{ id: 'rail', configured: true }] });
    if (options.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (options.headers.origin) return json({ error: 'cross_origin' }, 403);
    const query = JSON.parse(options.body);
    assert.deepEqual(query.modes, ['train']);
    const provider = { id: 'rail', status: query.from.name === 'Tokyo' ? 'empty' : query.date === tomorrow ? 'ok' : 'unavailable', calendar: { from: today, days: 10 } };
    const journeys = provider.status === 'ok' ? [rail] : [];
    if (options.headers.accept) {
      const events = [{ type: 'start' }, { type: 'provider', provider, journeys }, ...(!brokenStream ? [{ type: 'complete' }] : [])];
      return new Response(events.map((event) => JSON.stringify(event)).join('\n') + '\n', { headers: { ...apiHeaders, 'content-type': 'application/x-ndjson' } });
    }
    return json({ providers: [provider], journeys });
  };
  const verified = await verifyDeployment('https://travel-freely.account.workers.dev', tomorrow, { packaged, fetcher });
  assert.equal(verified.verifiedAssets, 2);
  assert.equal(verified.streaming, true);
  wrongBuild = true;
  await assert.rejects(verifyDeployment('https://travel-freely.account.workers.dev', tomorrow, { packaged, fetcher }), /build identity/);
  wrongBuild = false; brokenStream = true;
  await assert.rejects(verifyDeployment('https://travel-freely.account.workers.dev', tomorrow, { packaged, fetcher }), /did not complete/);
  await assert.rejects(verifyDeployment('https://travel-freely.account.workers.dev/elsewhere', tomorrow, { packaged, fetcher }), /origin/);
});
