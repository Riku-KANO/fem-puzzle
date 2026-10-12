// @ts-check
// Run: pnpm --dir deploy test   (= node --test "*.test.mjs"; no install needed)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkBuildOutput,
  checkDist,
  checkServed,
  findWorkersDevUrl,
  headersForPath,
  parseHeadersFile,
  patternToRegExp,
  servedPath,
} from './lib.mjs';

const DEPLOY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DEPLOY, '..');
const committedHeaders = readFileSync(join(ROOT, 'apps/web/public/_headers'), 'utf8');

const tmp = mkdtempSync(join(tmpdir(), 'deploy-check-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** @param {string} name @param {Record<string, string | Buffer>} files */
function site(name, files) {
  const dir = join(tmp, name);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

describe('_headers parsing', () => {
  test('the committed apps/web/public/_headers isolates every path', () => {
    const { rules, errors } = parseHeadersFile(committedHeaders);
    assert.deepEqual(errors, []);
    for (const p of ['/', '/index.html', '/assets/index-abc.js', '/assets/fem_wasm_bg-x.wasm', '/assets/w.js']) {
      const h = headersForPath(rules, p);
      assert.equal(h.get('cross-origin-opener-policy'), 'same-origin', p);
      assert.equal(h.get('cross-origin-embedder-policy'), 'require-corp', p);
    }
  });

  test('comments, detach, and syntax errors', () => {
    const { rules, errors } = parseHeadersFile(
      ['# c', '/a/*', '  X-A: 1', '  ! X-B', '  bogus', '/b/*/c/*', '/c', '  # indented comment', '  X-C: v: w'].join('\n'),
    );
    assert.equal(rules.length, 3);
    assert.deepEqual(rules[0]?.headers, [{ name: 'X-A', value: '1' }]);
    assert.deepEqual(rules[0]?.detach, ['x-b']);
    assert.deepEqual(rules[2]?.headers, [{ name: 'X-C', value: 'v: w' }]);
    assert.equal(errors.length, 2);
    assert.match(errors[0] ?? '', /:5: expected 'Name: value'/);
    assert.match(errors[1] ?? '', /more than one splat/);
    assert.match(parseHeadersFile('  X: 1').errors[0] ?? '', /before any URL pattern/);
  });

  test('limits: rule count and line length', () => {
    const many = Array.from({ length: 101 }, (_, i) => `/p${i}\n  X: 1`).join('\n');
    assert.match(parseHeadersFile(many).errors.at(-1) ?? '', /101 rules/);
    assert.match(parseHeadersFile(`/x\n  X: ${'a'.repeat(2000)}`).errors[0] ?? '', /longer than 2000/);
  });
});

describe('pattern matching', () => {
  test('splat and placeholders', () => {
    const splat = patternToRegExp('/*').re;
    assert.ok(splat.test('/') && splat.test('/a/b.wasm'));
    const ph = patternToRegExp('/movies/:title').re;
    assert.ok(ph.test('/movies/x') && !ph.test('/movies/x/y') && !ph.test('/movies/'));
    const dot = patternToRegExp('/*.wasm').re;
    assert.ok(dot.test('/assets/a.wasm') && !dot.test('/assets/awasm'));
  });

  test('absolute patterns need a host and ignore the scheme', () => {
    const { absolute, re } = patternToRegExp('https://:sub.workers.dev/*');
    assert.ok(absolute);
    assert.ok(re.test('https://carve.workers.dev/x') && re.test('http://carve.workers.dev/'));
    assert.ok(!re.test('https://a.b.workers.dev/'));
    const { rules } = parseHeadersFile('https://:sub.workers.dev/*\n  X-Robots-Tag: noindex');
    assert.equal(headersForPath(rules, '/').size, 0);
    assert.equal(headersForPath(rules, '/', 'carve.workers.dev').get('x-robots-tag'), 'noindex');
  });

  test('values of several matching rules are comma-joined (breaks COEP); detach removes', () => {
    const { rules } = parseHeadersFile(
      '/*\n  Cross-Origin-Embedder-Policy: require-corp\n/assets/*\n  Cross-Origin-Embedder-Policy: require-corp\n  ! X-Gone\n/*\n  X-Gone: 1',
    );
    assert.equal(headersForPath(rules, '/assets/a.js').get('cross-origin-embedder-policy'), 'require-corp, require-corp');
    assert.equal(headersForPath(rules, '/assets/a.js').has('x-gone'), false);
    assert.equal(headersForPath(rules, '/').get('x-gone'), '1');
  });
});

describe('checkDist', () => {
  test('a good build passes and reports wasm sizes', () => {
    const dir = site('good', {
      'index.html': '<script type="module" src="/assets/index-a.js"></script>',
      _headers: committedHeaders,
      'assets/index-a.js': 'x',
      'assets/fem_wasm_bg-a.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    });
    const r = checkDist(dir, { requireWasm: true });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.ok(r.notes.some((n) => n.startsWith('/assets/fem_wasm_bg-a.wasm: 8 B raw')));
  });

  test('missing _headers / index.html / wasm, oversize file, external script', () => {
    const dir = site('bad', { 'assets/big.bin': Buffer.alloc(25 * 1024 * 1024 + 1) });
    const r = checkDist(dir, { requireWasm: true });
    assert.ok(r.errors.some((e) => e.includes('index.html missing')));
    assert.ok(r.errors.some((e) => e.includes('_headers missing')));
    assert.ok(r.errors.some((e) => e.includes('no .wasm')));
    assert.ok(r.errors.some((e) => e.includes('/assets/big.bin is 25.00 MiB')));
    assert.equal(checkDist(dir).errors.some((e) => e.includes('no .wasm')), false, 'wasm optional by default');
    const ext = checkDist(site('ext', { 'index.html': '<script src="https://cdn.example.com/x.js"></script>', _headers: committedHeaders }));
    assert.ok(ext.warnings.some((w) => w.includes('cross-origin https://cdn.example.com/x.js')));
  });

  test('duplicated COEP in _headers is an error', () => {
    const dir = site('dup', {
      'index.html': '',
      _headers: `${committedHeaders}\n/assets/*\n  Cross-Origin-Embedder-Policy: require-corp\n`,
      'assets/a.js': '',
    });
    const r = checkDist(dir);
    assert.ok(r.errors.some((e) => e.includes("'require-corp, require-corp'")), r.errors.join('\n'));
  });

  test('unreadable dist', () => {
    assert.match(checkDist(join(tmp, 'nope')).errors[0] ?? '', /cannot read/);
  });
});

describe('checkBuildOutput', () => {
  const files = { 'index.html': '<p>', _headers: committedHeaders, 'assets/a.js': 'js' };
  const siteFiles = checkDist(site('bo-site', files)).files;
  /** @param {string} name @param {object} rootConfig @param {Record<string, string>} assets */
  const output = (name, rootConfig, assets) =>
    site(name, {
      'config.json': JSON.stringify(rootConfig),
      'workers/default/worker.config.json': JSON.stringify({ name: 'stress-carve', compatibilityDate: '2026-10-01' }),
      ...Object.fromEntries(Object.entries(assets).map(([p, b]) => [`workers/default/assets/${p}`, b])),
    });

  test('matching assets and mode pass', () => {
    const r = checkBuildOutput(output('bo-ok', { buildContext: { isPreview: false, mode: 'production' } }, files), siteFiles);
    assert.deepEqual(r.errors, []);
    assert.ok(r.notes.some((n) => n.startsWith('assets = site (3 files')));
  });

  test('stale assets and a missing mode fail', () => {
    const r = checkBuildOutput(
      output('bo-stale', { buildContext: { isPreview: false } }, { 'index.html': '<p>old', 'assets/old.js': 'x' }),
      siteFiles,
    );
    assert.ok(r.errors.some((e) => e.includes("mode is missing")), r.errors.join('\n'));
    assert.ok(r.errors.some((e) => e.includes('lacks 2 site file(s)')));
    assert.ok(r.errors.some((e) => e.includes('/assets/old.js')));
    assert.ok(r.errors.some((e) => e.includes('differs in size') && e.includes('/index.html')));
  });

  test('no build output yet', () => {
    const r = checkBuildOutput(join(tmp, 'nothing'), siteFiles);
    assert.ok(r.errors.some((e) => e.startsWith('config.json:') && e.includes('cf build --mode production')));
  });
});

describe('checkServed (fake fetch)', () => {
  const iso = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
  /** @param {Record<string, { status?: number, headers: Record<string, string> }>} table */
  const fakeFetch = (table) =>
    /** @type {typeof fetch} */ (
      async (input) => {
        const hit = table[new URL(String(input)).pathname];
        if (!hit) return new Response('nf', { status: 404 });
        return new Response('', { status: hit.status ?? 200, headers: hit.headers });
      }
    );
  const files = [{ path: '/index.html' }, { path: '/_headers' }, { path: '/assets/a.js' }, { path: '/assets/s.wasm' }, { path: '/assets/a.css' }];

  test('Workers-Static-Assets-like responses pass', async () => {
    const r = await checkServed('https://stress-carve.example.workers.dev/', files, {
      fetchImpl: fakeFetch({
        '/': { headers: { 'content-type': 'text/html; charset=utf-8', ...iso } },
        '/assets/a.js': { headers: { 'content-type': 'text/javascript; charset=utf-8', ...iso } },
        '/assets/s.wasm': { headers: { 'content-type': 'application/wasm', 'content-encoding': 'br', ...iso } },
      }),
    });
    assert.deepEqual(r.errors, []);
    assert.ok(r.notes.some((n) => n.includes('/assets/s.wasm 200 application/wasm encoding=br')));
  });

  test('wrong wasm MIME, missing COEP on scripts, non-isolated document', async () => {
    const r = await checkServed('http://localhost:1', files, {
      fetchImpl: fakeFetch({
        '/': { headers: { 'content-type': 'text/html' } },
        '/assets/a.js': { headers: { 'content-type': 'text/javascript' } },
        '/assets/s.wasm': { headers: { 'content-type': 'application/octet-stream', ...iso } },
      }),
    });
    assert.equal(r.errors.length, 4, r.errors.join('\n'));
    assert.ok(r.errors.some((e) => e.includes('need application/wasm')));
    assert.ok(r.errors.some((e) => e.includes('GET /assets/a.js: COEP missing')));
  });

  test('retries 404 until the deployment is live', async () => {
    let calls = 0;
    const live = fakeFetch({ '/': { headers: { 'content-type': 'text/html', ...iso } } });
    /** @type {typeof fetch} */
    const flaky = async (input, init) => (++calls < 3 ? new Response('', { status: 404 }) : live(input, init));
    const r = await checkServed('https://x.workers.dev', [], { fetchImpl: flaky, retries: 5, retryDelayMs: 1 });
    assert.deepEqual(r.errors, []);
    assert.equal(calls, 3);
  });

  test('Cloudflare Access protected sites are skipped, not failed', async () => {
    const r = await checkServed('https://x.workers.dev', files, {
      fetchImpl: fakeFetch({ '/': { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' } } }),
    });
    assert.ok(r.protectedByAccess);
    assert.deepEqual(r.errors, []);
  });
});

test('servedPath follows htmlHandling auto-trailing-slash', () => {
  assert.equal(servedPath('/index.html'), '/');
  assert.equal(servedPath('/a/index.html'), '/a/');
  assert.equal(servedPath('/about.html'), '/about');
  assert.equal(servedPath('/assets/x.js'), '/assets/x.js');
});

test('findWorkersDevUrl tolerates colours and surrounding text', () => {
  assert.equal(
    findWorkersDevUrl('Deployed \u001b[36mhttps://stress-carve.my-team.workers.dev\u001b[0m (1.2 s)\nhttps://x.workers.dev'),
    'https://stress-carve.my-team.workers.dev',
  );
  assert.equal(findWorkersDevUrl('Uploaded 3 assets'), undefined);
});

describe('deploy project policy', () => {
  const pkg = JSON.parse(readFileSync(join(DEPLOY, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  test('cf and the Cloudflare Vite plugin are pinned to exact versions', () => {
    for (const name of ['cf', '@cloudflare/vite-plugin', 'vite']) {
      assert.match(deps[name] ?? '', /^\d+\.\d+\.\d+(-[\w.-]+)?$/, `${name} must be an exact version, got ${deps[name]}`);
    }
  });

  test('no Wrangler anywhere in the deploy project (user decision, ADR 0002)', () => {
    assert.equal(Object.keys(deps).some((d) => d.includes('wrangler')), false);
    assert.doesNotMatch(readFileSync(join(DEPLOY, 'pnpm-lock.yaml'), 'utf8'), /wrangler/);
    assert.doesNotMatch(readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8'), /wrangler/i);
  });

  test('the deploy workflow disables telemetry and deploys the prebuilt output', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    assert.match(wf, /DO_NOT_TRACK: '1'/);
    assert.match(wf, /cf deploy --prebuilt --mode production/);
    assert.match(wf, /^on:\n {2}workflow_dispatch:/m);
  });
});
