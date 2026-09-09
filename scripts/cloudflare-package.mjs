import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { experimental_readRawConfig, unstable_readConfig } from 'wrangler';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function inside(root, path) {
  const base = resolve(root), target = resolve(base, path);
  if (!target.startsWith(base + sep)) throw new Error('Package path escaped its directory.');
  if (existsSync(base) && lstatSync(base).isSymbolicLink()) throw new Error('Symlinked package directories are not allowed.');
  // Reject links in any path component, including parent directories.
  let current = base;
  for (const part of relative(base, target).split(sep)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Symlinked package files are not allowed.');
  }
  return target;
}

export function sourceFingerprint(root) {
  const hash = createHash('sha256');
  const walk = (path) => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Symlinked deployment sources are not allowed.');
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (!name.startsWith('.') && name !== 'node_modules') walk(join(path, name));
      }
    } else if (stat.isFile()) {
      hash.update(relative(root, path).split(sep).join('/') + '\0');
      hash.update(sha256(readFileSync(path)) + '\0');
    }
  };
  for (const path of ['src', 'worker', 'public', 'scripts', 'index.html', 'vite.config.js', 'package.json', 'package-lock.json', 'wrangler.jsonc']) walk(join(root, path));
  return hash.digest('hex');
}

export function readConfiguration(root) {
  const path = join(root, 'wrangler.jsonc');
  // Use Wrangler's JSONC parser and validation; comments and trailing commas are valid.
  const { rawConfig: config } = experimental_readRawConfig({ config: path });
  unstable_readConfig({ config: path }, { hideWarnings: true });
  const supported = new Set(['$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'assets', 'ratelimits', 'vars', 'keep_vars', 'observability']);
  if (Object.keys(config).some((key) => !supported.has(key))) throw new Error('Unsupported Wrangler setting: update the deployment metadata converter before packaging.');
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(config.name || '') || config.main !== 'worker/index.js') throw new Error('Invalid Worker name or entry point.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date || '')) throw new Error('A pinned compatibility date is required.');
  if (config.observability?.enabled !== false || config.observability?.logs?.enabled === true || config.observability?.traces?.enabled === true) throw new Error('Travel request logging must remain disabled.');
  if (config.keep_vars !== true) throw new Error('Set keep_vars:true to preserve configured provider settings.');
  if (config.assets?.directory !== './dist' || config.assets?.binding !== 'ASSETS'
    || config.assets?.not_found_handling !== 'single-page-application'
    || JSON.stringify(config.assets?.run_worker_first) !== '["/api/*"]'
    || Object.keys(config.assets).some((key) => !['directory', 'binding', 'not_found_handling', 'run_worker_first'].includes(key))) throw new Error('Unsupported static asset routing configuration.');
  if (Object.keys(config.vars || {}).some((name) => /(?:SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY)/i.test(name))) throw new Error('Provider credentials belong in Cloudflare secrets, never Wrangler vars.');
  return config;
}

export function parseHeaders(text) {
  const rules = [];
  let rule;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.length > 2000) throw new Error('Static header line exceeds Cloudflare limits.');
    if (!/^\s/.test(line)) {
      if (!/^\/[\w./*-]*$/.test(line) || (line.match(/\*/g) || []).length > 1) throw new Error('Unsupported static header path rule.');
      rule = { path: line, headers: {} };
      rules.push(rule);
    } else {
      const match = /^\s+([\w-]+):\s*(.+)$/.exec(line);
      if (!rule || !match) throw new Error('Invalid static header definition.');
      const name = match[1].toLowerCase();
      rule.headers[name] = rule.headers[name] ? `${rule.headers[name]}, ${match[2]}` : match[2];
    }
  }
  if (rules.length > 100) throw new Error('Too many static header rules.');
  return rules;
}

// Kept self-contained because this exact function is embedded in the portable Worker.
export function serveBundled(request, assets, rules) {
  const path = new URL(request.url).pathname;
  const headers = new Headers({ 'cache-control': 'public, max-age=0, must-revalidate' });
  for (const rule of rules) {
    const [prefix, suffix] = rule.path.split('*');
    if (rule.path.includes('*') ? path.startsWith(prefix) && path.endsWith(suffix) : path === rule.path) {
      for (const [name, value] of Object.entries(rule.headers)) {
        if (name === 'cache-control') headers.set(name, value);
        else headers.append(name, value);
      }
    }
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    headers.set('allow', 'GET, HEAD');
    return new Response('Method not allowed', { status: 405, headers });
  }
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return new Response(request.method === 'HEAD' ? null : 'Not found', { status: 404, headers }); }
  const safe = !decoded.includes('\\') && !decoded.includes('\0') && !decoded.split('/').some((part) => part === '..' || part.startsWith('.'));
  const file = safe && (assets[decoded] || (decoded === '/' || (!decoded.startsWith('/assets/') && !decoded.split('/').pop().includes('.')) ? assets['/index.html'] : null));
  if (!file) return new Response(request.method === 'HEAD' ? null : 'Not found', { status: 404, headers });
  headers.set('content-type', file.mime);
  headers.set('etag', file.etag);
  if ((request.headers.get('if-none-match') || '').split(',').map((value) => value.trim().replace(/^W\//, '')).some((value) => value === '*' || value === file.etag)) return new Response(null, { status: 304, headers });
  const body = request.method === 'HEAD' ? null : file.binary ? Uint8Array.from(atob(file.body), (c) => c.charCodeAt(0)) : file.body;
  return new Response(body, { headers });
}

export function uploadMetadata(config, headers, buildId, bundled = false) {
  const { directory, binding, ...assetConfig } = config.assets;
  return {
    main_module: 'worker.mjs', compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags || [],
    keep_bindings: ['secret_text', 'secret_key', 'plain_text', 'json'],
    bindings: [
      ...(!bundled ? [{ type: 'assets', name: binding }] : []),
      ...(config.ratelimits || []).map((rate) => ({ type: 'ratelimit', ...rate })),
      ...Object.entries({ ...config.vars, BUILD_ID: buildId }).map(([name, value]) => typeof value === 'string' ? { type: 'plain_text', name, text: value } : { type: 'json', name, json: value }),
    ],
    observability: config.observability,
    ...(!bundled ? { assets: { config: { ...assetConfig, _headers: headers } } } : {}),
  };
}
