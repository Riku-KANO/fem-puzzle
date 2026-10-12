// @ts-check
// Pure helpers behind deploy/check.mjs: `_headers` parsing/matching (same format on Workers
// Static Assets and Pages), static checks of the built site (apps/web/dist), of the cf Build
// Output, and HTTP checks of a served copy. Node >= 22 built-ins only.
// Tests: `pnpm --dir deploy test` (= node --test "*.test.mjs").

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

/** Workers Static Assets limits (developers.cloudflare.com/workers/platform/limits/,
 *  …/workers/static-assets/headers/). */
export const ASSET_LIMITS = {
  maxFiles: 20_000, // per Worker version on the Free plan (100,000 on Paid)
  maxFileBytes: 25 * 1024 * 1024, // per asset
  maxHeaderRules: 100, // `_headers` rules
  maxHeaderLineChars: 2_000, // `_headers` line length
};

/** Files the asset server consumes as configuration instead of serving them. */
export const CONFIG_FILES = new Set(['/_headers', '/_redirects']);

/** Where `cf build` writes the Build Output Specification (relative to the cf project). */
export const BUILD_OUTPUT_DIR = '.cloudflare/output/v0';

/**
 * @typedef {{ name: string, value: string }} Header
 * @typedef {{ pattern: string, lineNo: number, headers: Header[], detach: string[] }} HeaderRule
 * @typedef {{ rules: HeaderRule[], errors: string[] }} ParsedHeaders
 * @typedef {{ errors: string[], warnings: string[], notes: string[] }} Report
 * @typedef {{ path: string, file: string, bytes: number }} DistFile
 */

/** @returns {Report} */
export function emptyReport() {
  return { errors: [], warnings: [], notes: [] };
}

/**
 * Parses a `_headers` file: an unindented line starts a rule (URL pattern), indented
 * `Name: value` lines add headers, indented `! Name` lines detach a header, `#` starts a
 * comment line.
 * @param {string} text
 * @returns {ParsedHeaders}
 */
export function parseHeadersFile(text) {
  /** @type {HeaderRule[]} */
  const rules = [];
  /** @type {string[]} */
  const errors = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    if (raw.length > ASSET_LIMITS.maxHeaderLineChars) {
      errors.push(`_headers:${lineNo}: line longer than ${ASSET_LIMITS.maxHeaderLineChars} chars`);
    }
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    if (!/^\s/.test(raw)) {
      if ((trimmed.match(/\*/g) ?? []).length > 1) {
        errors.push(`_headers:${lineNo}: pattern '${trimmed}' has more than one splat (*)`);
      }
      rules.push({ pattern: trimmed, lineNo, headers: [], detach: [] });
      return;
    }
    const rule = rules.at(-1);
    if (!rule) {
      errors.push(`_headers:${lineNo}: header line before any URL pattern`);
      return;
    }
    if (trimmed.startsWith('!')) {
      const name = trimmed.slice(1).trim();
      if (name) rule.detach.push(name.toLowerCase());
      else errors.push(`_headers:${lineNo}: empty detach ('!') line`);
      return;
    }
    const colon = trimmed.indexOf(':');
    if (colon <= 0) {
      errors.push(`_headers:${lineNo}: expected 'Name: value', got '${trimmed}'`);
      return;
    }
    rule.headers.push({ name: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim() });
  });
  if (rules.length > ASSET_LIMITS.maxHeaderRules) {
    errors.push(`_headers: ${rules.length} rules, at most ${ASSET_LIMITS.maxHeaderRules} allowed`);
  }
  return { rules, errors };
}

/**
 * Converts a `_headers` URL pattern into a RegExp over `https://host/path` (absolute
 * patterns) or `/path` (path patterns). `*` matches anything (greedy), `:name` matches one
 * path segment (or one host label).
 * @param {string} pattern
 * @returns {{ absolute: boolean, re: RegExp }}
 */
export function patternToRegExp(pattern) {
  const absolute = /^https?:\/\//.test(pattern);
  let hostEnd = -1;
  if (absolute) {
    const slash = pattern.indexOf('/', pattern.indexOf('//') + 2);
    hostEnd = slash === -1 ? pattern.length : slash;
  }
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = /** @type {string} */ (pattern[i]);
    if (ch === '*') {
      out += '(.*)';
    } else if (ch === ':' && /[A-Za-z_]/.test(pattern[i + 1] ?? '')) {
      let j = i + 1;
      while (j < pattern.length && /\w/.test(/** @type {string} */ (pattern[j]))) j++;
      out += i < hostEnd ? '([^./]+)' : '([^/]+)';
      i = j - 1;
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  // The scheme (and port) are ignored when matching absolute patterns.
  if (absolute) out = out.replace(/^https?:\\\/\\\//, 'https?:\\/\\/');
  return { absolute, re: new RegExp(`^${out}$`) };
}

/**
 * Headers `_headers` attaches to a request path (Cloudflare's own defaults not included).
 * Matching rules accumulate; a header set by several rules gets its values joined with ", "
 * (documented behaviour); `! Name` removes a header. Absolute (host) patterns are only
 * considered when `host` is given.
 * @param {HeaderRule[]} rules
 * @param {string} path request path starting with '/'
 * @param {string} [host]
 * @returns {Map<string, string>} lower-case header name → value
 */
export function headersForPath(rules, path, host) {
  /** @type {Map<string, string[]>} */
  const acc = new Map();
  /** @type {Set<string>} */
  const detached = new Set();
  for (const rule of rules) {
    const { absolute, re } = patternToRegExp(rule.pattern);
    if (absolute && !host) continue;
    if (!re.test(absolute ? `https://${host}${path}` : path)) continue;
    for (const h of rule.headers) {
      const key = h.name.toLowerCase();
      acc.set(key, [...(acc.get(key) ?? []), h.value]);
    }
    for (const d of rule.detach) detached.add(d);
  }
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const [k, v] of acc) if (!detached.has(k)) out.set(k, v.join(', '));
  return out;
}

/**
 * Cross-origin isolation requirements for a document / worker-script response.
 * @param {{ get(name: string): string | null | undefined }} headers lower-case lookup
 * @param {string} where label for messages
 * @param {Report} report
 */
export function checkIsolation(headers, where, report) {
  const coop = headers.get('cross-origin-opener-policy');
  const coep = headers.get('cross-origin-embedder-policy');
  if (coop !== 'same-origin') {
    report.errors.push(`${where}: Cross-Origin-Opener-Policy is ${fmt(coop)}, need 'same-origin'`);
  }
  if (coep === 'credentialless') {
    report.warnings.push(`${where}: COEP 'credentialless' is not supported by Safari; prefer 'require-corp'`);
  } else if (coep !== 'require-corp') {
    report.errors.push(`${where}: Cross-Origin-Embedder-Policy is ${fmt(coep)}, need 'require-corp'`);
  }
}

/** @param {string | null | undefined} v */
function fmt(v) {
  return v == null ? 'missing' : `'${v}'`;
}

/**
 * Lists every file below `dir` as a URL path ('/assets/x.js') with its size.
 * @param {string} dir
 * @returns {DistFile[]}
 */
export function listDist(dir) {
  /** @type {DistFile[]} */
  const out = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const file = join(d, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        out.push({ path: `/${relative(dir, file).split(sep).join('/')}`, file, bytes: statSync(file).size });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** @param {number} n */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/** @param {unknown} e */
function message(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Static checks of a built site directory (apps/web/dist) before it is shipped.
 * @param {string} dir
 * @param {{ requireWasm?: boolean }} [opts]
 * @returns {Report & { files: DistFile[] }}
 */
export function checkDist(dir, opts = {}) {
  const report = emptyReport();
  /** @type {DistFile[]} */
  let files;
  try {
    files = listDist(dir);
  } catch (e) {
    report.errors.push(`${dir}: cannot read (${message(e)}); run \`pnpm build\` at the repo root first`);
    return { ...report, files: [] };
  }
  const byPath = new Map(files.map((f) => [f.path, f]));

  if (!byPath.has('/index.html')) report.errors.push(`${dir}/index.html missing`);

  if (files.length > ASSET_LIMITS.maxFiles) {
    report.errors.push(`${files.length} files, Workers Free allows ${ASSET_LIMITS.maxFiles} per version`);
  }
  for (const f of files) {
    if (f.bytes > ASSET_LIMITS.maxFileBytes) {
      report.errors.push(`${f.path} is ${formatBytes(f.bytes)}, the limit is ${formatBytes(ASSET_LIMITS.maxFileBytes)} per asset`);
    }
  }
  report.notes.push(`${files.length} files, ${formatBytes(files.reduce((s, f) => s + f.bytes, 0))} total`);

  // _headers: present, parseable, and every served path is cross-origin isolated.
  const headersFile = byPath.get('/_headers');
  if (!headersFile) {
    report.errors.push(`${dir}/_headers missing (apps/web/public/_headers is copied by vite build)`);
  } else {
    const parsed = parseHeadersFile(readFileSync(headersFile.file, 'utf8'));
    report.errors.push(...parsed.errors);
    report.notes.push(`_headers: ${parsed.rules.length} rule(s)`);
    const served = ['/', ...files.map((f) => f.path).filter((p) => !CONFIG_FILES.has(p))];
    const before = report.errors.length;
    for (const p of served) checkIsolation(headersForPath(parsed.rules, p), `_headers for ${p}`, report);
    // One bad pattern would otherwise repeat for every file.
    const extra = report.errors.splice(before + 3);
    if (extra.length) report.errors.push(`… ${extra.length} more _headers isolation errors`);
  }

  // The solver binary.
  const wasm = files.filter((f) => f.path.endsWith('.wasm'));
  if (wasm.length === 0) {
    (opts.requireWasm ? report.errors : report.warnings).push(
      'no .wasm in the build (the web app does not import fem-wasm yet — T-205)',
    );
  }
  for (const f of wasm) {
    const bytes = readFileSync(f.file);
    report.notes.push(
      `${f.path}: ${formatBytes(f.bytes)} raw, ${formatBytes(gzipSync(bytes, { level: 9 }).length)} gzip, ` +
        `${formatBytes(brotliCompressSync(bytes).length)} brotli`,
    );
  }

  // COEP require-corp blocks cross-origin subresources that lack CORP/CORS headers.
  const index = byPath.get('/index.html');
  if (index) {
    const html = readFileSync(index.file, 'utf8');
    for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)) {
      report.warnings.push(
        `index.html loads cross-origin ${m[1]}: under COEP require-corp it needs CORP/CORS headers (+ crossorigin attribute)`,
      );
    }
  }
  return { ...report, files };
}

/**
 * Checks the Build Output written by `cf build` (`<project>/.cloudflare/output/v0`): an
 * assets-only default Worker whose assets are exactly the site directory, built in `mode`.
 * @param {string} outputDir e.g. deploy/.cloudflare/output/v0
 * @param {DistFile[]} siteFiles from checkDist
 * @param {{ mode?: string }} [opts]
 * @returns {Report}
 */
export function checkBuildOutput(outputDir, siteFiles, opts = {}) {
  const { mode = 'production' } = opts;
  const report = emptyReport();
  /** @param {string} rel */
  const readJson = (rel) => {
    try {
      return JSON.parse(readFileSync(join(outputDir, rel), 'utf8'));
    } catch (e) {
      report.errors.push(`${rel}: ${message(e)} — run \`pnpm --dir deploy build\` (cf build --mode ${mode})`);
      return undefined;
    }
  };
  const root = readJson('config.json');
  if (root) {
    const built = root?.buildContext?.mode;
    if (built !== mode) {
      report.errors.push(`config.json buildContext.mode is ${fmt(built)}; \`cf deploy --prebuilt --mode ${mode}\` needs '${mode}'`);
    }
    if (root?.buildContext?.isPreview) report.warnings.push('config.json: built as a Preview build');
  }
  const worker = readJson('workers/default/worker.config.json');
  if (worker) {
    report.notes.push(`worker '${worker.name}', compatibilityDate ${worker.compatibilityDate}, assets ${JSON.stringify(worker.assets ?? {})}`);
    if (worker.manifest) report.warnings.push('worker.config.json has a bundle manifest: expected an assets-only Worker');
  }
  /** @type {DistFile[]} */
  let assets = [];
  try {
    assets = listDist(join(outputDir, 'workers/default/assets'));
  } catch (e) {
    report.errors.push(`workers/default/assets: ${message(e)}`);
    return report;
  }
  const want = new Map(siteFiles.map((f) => [f.path, f.bytes]));
  const got = new Map(assets.map((f) => [f.path, f.bytes]));
  const missing = [...want.keys()].filter((p) => !got.has(p));
  const extra = [...got.keys()].filter((p) => !want.has(p));
  const changed = [...want].filter(([p, b]) => got.has(p) && got.get(p) !== b).map(([p]) => p);
  if (missing.length) report.errors.push(`Build Output lacks ${missing.length} site file(s): ${missing.slice(0, 5).join(', ')} (stale? rerun cf build)`);
  if (extra.length) report.errors.push(`Build Output has ${extra.length} file(s) not in the site: ${extra.slice(0, 5).join(', ')} (stale? rerun cf build)`);
  if (changed.length) report.errors.push(`Build Output differs in size from the site: ${changed.slice(0, 5).join(', ')} (stale? rerun cf build)`);
  if (!missing.length && !extra.length && !changed.length) {
    report.notes.push(`assets = site (${assets.length} files, ${formatBytes(assets.reduce((s, f) => s + f.bytes, 0))})`);
  }
  return report;
}

/**
 * URL path a built file is requested at (`htmlHandling: auto-trailing-slash`, the default):
 * `/x/index.html` at `/x/`, `/x.html` at `/x`.
 * @param {string} path
 */
export function servedPath(path) {
  if (path.endsWith('/index.html')) return path.slice(0, -'index.html'.length);
  if (path.endsWith('.html')) return path.slice(0, -'.html'.length);
  return path;
}

/** @param {string | null} ct */
function mime(ct) {
  return (ct ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * HTTP checks against a served copy of the site (the Cloudflare plugin's `vite preview`,
 * `cf dev`, or the live Worker): documents are cross-origin isolated, scripts (possible worker
 * entries) carry COEP, `.wasm` is application/wasm.
 * @param {string} baseUrl
 * @param {{ path: string }[]} files from checkDist/listDist
 * @param {{ retries?: number, retryDelayMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Report & { protectedByAccess: boolean }>}
 */
export async function checkServed(baseUrl, files, opts = {}) {
  const { retries = 0, retryDelayMs = 3000, fetchImpl = fetch } = opts;
  const report = emptyReport();
  const base = baseUrl.replace(/\/+$/, '');

  /** @param {string} path */
  const get = async (path) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(base + path, { redirect: 'manual', headers: { 'accept-encoding': 'br, gzip' } });
        await res.arrayBuffer();
        if ((res.status === 404 || res.status >= 500) && attempt < retries) {
          await sleep(retryDelayMs);
          continue;
        }
        return res;
      } catch (e) {
        if (attempt >= retries) throw e;
        await sleep(retryDelayMs);
      }
    }
  };

  const root = await get('/');
  const location = root.headers.get('location') ?? '';
  if (root.status >= 300 && root.status < 400 && /cloudflareaccess\.com/.test(location)) {
    report.warnings.push(`${base}/ is behind Cloudflare Access; HTTP checks skipped`);
    return { ...report, protectedByAccess: true };
  }
  if (root.status !== 200) {
    report.errors.push(`GET / → ${root.status}${location ? ` (Location: ${location})` : ''}`);
    return { ...report, protectedByAccess: false };
  }
  if (mime(root.headers.get('content-type')) !== 'text/html') {
    report.errors.push(`GET / content-type ${fmt(root.headers.get('content-type'))}, expected text/html`);
  }
  checkIsolation(root.headers, 'GET /', report);
  report.notes.push(
    `GET / 200 COOP=${root.headers.get('cross-origin-opener-policy')} COEP=${root.headers.get('cross-origin-embedder-policy')}`,
  );

  for (const f of files) {
    if (CONFIG_FILES.has(f.path) || f.path === '/index.html') continue;
    const kind = f.path.endsWith('.wasm') ? 'wasm' : /\.m?js$/.test(f.path) ? 'js' : f.path.endsWith('.html') ? 'html' : null;
    if (!kind) continue;
    const path = servedPath(f.path);
    const res = await get(path);
    if (res.status !== 200) {
      report.errors.push(`GET ${path} → ${res.status}`);
      continue;
    }
    const ct = mime(res.headers.get('content-type'));
    const enc = res.headers.get('content-encoding') ?? 'identity';
    if (kind === 'wasm') {
      if (ct !== 'application/wasm') {
        report.errors.push(`GET ${path} content-type '${ct}', need application/wasm (instantiateStreaming)`);
      }
      report.notes.push(`GET ${path} 200 ${ct} encoding=${enc}`);
    } else if (kind === 'js') {
      if (ct !== 'text/javascript' && ct !== 'application/javascript') {
        report.errors.push(`GET ${path} content-type '${ct}', expected JavaScript`);
      }
      // A worker script needs its own COEP for the worker to be cross-origin isolated.
      const coep = res.headers.get('cross-origin-embedder-policy');
      if (coep !== 'require-corp' && coep !== 'credentialless') {
        report.errors.push(`GET ${path}: COEP ${fmt(coep)} (worker scripts need it)`);
      }
    } else {
      checkIsolation(res.headers, `GET ${path}`, report);
    }
  }
  return { ...report, protectedByAccess: false };
}

/**
 * First workers.dev URL in `cf deploy` output (the beta's output format is not documented,
 * so this is best effort).
 * @param {string} text
 * @returns {string | undefined}
 */
export function findWorkersDevUrl(text) {
  // Strip ANSI colour codes first.
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  return plain.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\b/i)?.[0];
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
