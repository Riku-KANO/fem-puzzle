#!/usr/bin/env node
// @ts-check
// Pre/post-deploy checks for the Cloudflare build. See deploy/README.md.
//
//   node deploy/check.mjs                  apps/web/dist: _headers isolation, limits, wasm size
//   node deploy/check.mjs --build-output   + deploy/.cloudflare/output/v0 (`cf build`) = that site
//   node deploy/check.mjs --serve          + serve the Build Output with the Cloudflare plugin's
//                                            `vite preview` (workerd), check over HTTP, stop it
//   node deploy/check.mjs --url <base>     + check a running server / the live Worker
//   node deploy/check.mjs --find-url <log> print the first *.workers.dev URL in a `cf deploy` log
//
// Options: --dist <dir> (default apps/web/dist), --require-wasm, --port <n> (default 8788),
//          --retries <n> (HTTP retries on 404/5xx, for a fresh deployment).
// Exit code 0 = no errors (warnings allowed), 1 = errors, 2 = usage.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BUILD_OUTPUT_DIR, checkBuildOutput, checkDist, checkServed, findWorkersDevUrl } from './lib.mjs';

const DEPLOY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DEPLOY, '..');

/** @param {string} msg @returns {never} */
function usage(msg) {
  console.error(
    `check.mjs: ${msg}\n` +
      'usage: node deploy/check.mjs [--dist <dir>] [--require-wasm] [--build-output] [--serve | --url <base>] [--port n] [--retries n]\n' +
      '       node deploy/check.mjs --find-url <cf-deploy.log>',
  );
  process.exit(2);
}

/** @type {Record<string, string | boolean | undefined>} */
let values = {};
try {
  ({ values } = parseArgs({
    options: {
      dist: { type: 'string' },
      'require-wasm': { type: 'boolean' },
      'build-output': { type: 'boolean' },
      serve: { type: 'boolean' },
      url: { type: 'string' },
      port: { type: 'string' },
      retries: { type: 'string' },
      'find-url': { type: 'string' },
    },
  }));
} catch (e) {
  usage(e instanceof Error ? e.message : String(e));
}

if (typeof values['find-url'] === 'string') {
  const url = findWorkersDevUrl(readFileSync(values['find-url'], 'utf8'));
  if (url) console.log(url);
  process.exit(url ? 0 : 1);
}

if (values.serve && values.url) usage('--serve and --url are exclusive');
const port = Number(values.port ?? '8788');
const retries = Number(values.retries ?? '0');
if (!Number.isInteger(port) || port <= 0) usage(`--port ${values.port}`);
if (!Number.isInteger(retries) || retries < 0) usage(`--retries ${values.retries}`);
const dist = resolve(typeof values.dist === 'string' ? values.dist : join(ROOT, 'apps/web/dist'));

let failed = false;
/** @param {string} title @param {import('./lib.mjs').Report} r */
function print(title, r) {
  console.log(`── ${title}`);
  for (const n of r.notes) console.log(`  ok    ${n}`);
  for (const w of r.warnings) console.log(`  warn  ${w}`);
  for (const e of r.errors) console.log(`  FAIL  ${e}`);
  if (r.errors.length) failed = true;
}

const site = checkDist(dist, { requireWasm: values['require-wasm'] === true });
print(`site: ${dist}`, site);

if (site.files.length && (values['build-output'] || values.serve)) {
  const out = join(DEPLOY, BUILD_OUTPUT_DIR);
  print(`cf Build Output: ${out}`, checkBuildOutput(out, site.files));
}

if (site.files.length && !failed && (values.serve || typeof values.url === 'string')) {
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let server;
  const base = typeof values.url === 'string' ? values.url : `http://127.0.0.1:${port}`;
  try {
    if (values.serve) {
      server = startPreview(port);
      await waitUntilUp(base, server, 60_000);
    }
    const http = await checkServed(base, site.files, { retries });
    print(`http: ${base}${values.serve ? ' (Cloudflare vite preview, workerd)' : ''}`, http);
  } catch (e) {
    print(`http: ${base}`, { errors: [e instanceof Error ? e.message : String(e)], warnings: [], notes: [] });
  } finally {
    if (server) await stopServer(server);
  }
}

console.log(failed ? '✗ deploy check failed' : '✓ deploy check passed');
process.exit(failed ? 1 : 0);

/**
 * The Cloudflare Vite plugin's preview: serves deploy/.cloudflare/output through workerd with
 * the production asset handling (_headers, content types, SPA fallback). No login needed.
 * @param {number} p
 */
function startPreview(p) {
  const child = spawn(
    join(DEPLOY, 'node_modules/.bin/vite'),
    ['preview', '--port', String(p), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: DEPLOY,
      detached: true, // own process group, so vite and workerd stop together
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DO_NOT_TRACK: '1', CF_SEND_TELEMETRY: 'false' },
    },
  );
  /** @type {string[]} */
  const log = [];
  const keep = (/** @type {Buffer} */ b) => {
    log.push(b.toString());
    if (log.length > 50) log.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  Object.assign(child, { recentLog: log });
  return child;
}

/**
 * @param {string} base
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 */
async function waitUntilUp(base, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      await fetch(base, { redirect: 'manual' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const log = /** @type {{ recentLog?: string[] }} */ (child).recentLog?.join('').slice(-2000) ?? '';
  throw new Error(`preview did not come up on ${base} within ${timeoutMs / 1000}s\n${log}`);
}

/** @param {import('node:child_process').ChildProcess} child */
async function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  const exited = new Promise((r) => child.once('exit', r));
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, 5000);
  await exited;
  clearTimeout(timer);
}
