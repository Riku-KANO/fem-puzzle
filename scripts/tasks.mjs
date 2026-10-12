#!/usr/bin/env node
// Task board for the parallel development loop. Tasks are Markdown files in docs/tasks/
// with a small YAML front matter (see docs/loop/README.md). No dependencies on purpose.
//
//   node scripts/tasks.mjs [list]          board grouped by status
//   node scripts/tasks.mjs ready [--early] todo tasks whose deps are done and whose `owns`
//                                          paths do not overlap a task in progress.
//                                          --early: deps may also be in progress (doing/review) —
//                                          the worker codes against the contract and pulls the
//                                          dependency's branch; it integrates after its deps.
//   node scripts/tasks.mjs plan [N] [--early]  greedily pick ≤ N ready tasks with disjoint `owns`
//
// `owns` entries starting with "!" are exclusions: `crates/fem/**` + `!crates/fem/src/mg/**`
// lets another task own the mg module while this one is in progress.
//   node scripts/tasks.mjs show <id>       print one task file
//   node scripts/tasks.mjs set <id> <status>
//   node scripts/tasks.mjs check           validate all task files (used by verify.sh)
//   add --json to list/ready/plan for machine-readable output

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASK_DIR = join(ROOT, 'docs', 'tasks');
const STATUSES = ['todo', 'doing', 'review', 'done', 'blocked'];
const REQUIRED = ['id', 'title', 'status', 'phase', 'depends', 'owns', 'verify'];

/** Parse the tiny YAML subset we use: scalars, inline lists, block lists. */
function parseFrontMatter(text, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const data = {};
  let listKey = null;
  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      data[listKey].push(unquote(item[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) throw new Error(`${file}: cannot parse front matter line: ${raw}`);
    const [, key, value] = kv;
    if (value === '') {
      data[key] = [];
      listKey = key;
    } else if (value.startsWith('[')) {
      const inner = value.replace(/^\[|\]$/g, '').trim();
      data[key] = inner ? inner.split(',').map((s) => unquote(s.trim())) : [];
      listKey = null;
    } else {
      data[key] = unquote(value.trim());
      listKey = null;
    }
  }
  return { data, body: text.slice(m[0].length) };
}

const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');

function loadTasks() {
  const files = readdirSync(TASK_DIR).filter((f) => /^T-\d+.*\.md$/.test(f)).sort();
  return files.map((f) => {
    const text = readFileSync(join(TASK_DIR, f), 'utf8');
    const { data } = parseFrontMatter(text, f);
    return { ...data, file: f, phase: Number(data.phase) };
  });
}

const base = (p) => p.replace(/^!/, '').replace(/\*.*$/, '').replace(/\/$/, '');
/** `inner` lies inside `outer` (path prefix after stripping globs). */
const within = (inner, outer) => outer === '' || inner === outer || inner.startsWith(outer + '/');

/**
 * Two ownership lists overlap if some included path of one lies inside an included path of
 * the other and is not carved out by an exclusion ("!path") of the containing list.
 */
function ownsOverlap(a, b) {
  const inc = (l) => l.filter((p) => !p.startsWith('!')).map(base);
  const exc = (l) => l.filter((p) => p.startsWith('!')).map(base);
  const [ia, ea, ib, eb] = [inc(a), exc(a), inc(b), exc(b)];
  for (const x of ia) {
    for (const y of ib) {
      if (within(y, x) && !ea.some((e) => within(y, e))) return true;
      if (within(x, y) && !eb.some((e) => within(x, e))) return true;
    }
  }
  return false;
}

function readyTasks(tasks, early = false) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const active = tasks.filter((t) => t.status === 'doing' || t.status === 'review');
  const satisfied = early ? ['done', 'doing', 'review'] : ['done'];
  return tasks
    .filter((t) => t.status === 'todo')
    .filter((t) => t.depends.every((d) => satisfied.includes(byId.get(d)?.status)))
    .filter((t) => !active.some((a) => ownsOverlap(a.owns, t.owns)))
    .sort((a, b) => a.phase - b.phase || a.id.localeCompare(b.id));
}

function plan(tasks, n, early = false) {
  const chosen = [];
  for (const t of readyTasks(tasks, early)) {
    if (chosen.length >= n) break;
    if (chosen.some((c) => ownsOverlap(c.owns, t.owns))) continue;
    chosen.push(t);
  }
  return chosen;
}

function check(tasks) {
  const errors = [];
  const ids = new Set();
  for (const t of tasks) {
    for (const k of REQUIRED) if (t[k] === undefined) errors.push(`${t.file}: missing '${k}'`);
    if (!t.file.startsWith(t.id)) errors.push(`${t.file}: file name must start with id ${t.id}`);
    if (ids.has(t.id)) errors.push(`${t.file}: duplicate id ${t.id}`);
    ids.add(t.id);
    if (!STATUSES.includes(t.status)) errors.push(`${t.file}: bad status '${t.status}'`);
    for (const k of ['depends', 'owns', 'verify']) {
      if (t[k] !== undefined && !Array.isArray(t[k])) errors.push(`${t.file}: '${k}' must be a list`);
    }
    if (Array.isArray(t.owns) && t.owns.length === 0 && t.status !== 'done') {
      errors.push(`${t.file}: 'owns' must list the paths this task may modify`);
    }
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const d of t.depends ?? []) {
      if (!byId.has(d)) errors.push(`${t.file}: unknown dependency ${d}`);
      else if (t.status === 'done' && byId.get(d).status !== 'done') {
        errors.push(`${t.file}: done but dependency ${d} is ${byId.get(d).status}`);
      }
    }
  }
  // cycles
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      errors.push(`dependency cycle: ${[...stack, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const d of byId.get(id)?.depends ?? []) visit(d, [...stack, id]);
    state.set(id, 'done');
  };
  for (const t of tasks) visit(t.id, []);
  // parallel safety: tasks in progress must not own overlapping paths
  const active = tasks.filter((t) => t.status === 'doing' || t.status === 'review');
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (ownsOverlap(active[i].owns, active[j].owns)) {
        errors.push(`ownership conflict between in-progress ${active[i].id} and ${active[j].id}`);
      }
    }
  }
  return errors;
}

function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const t = loadTasks().find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  const path = join(TASK_DIR, t.file);
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(/^(---\n[\s\S]*?^status:\s*)\S+/m, `$1${status}`));
  console.log(`${id}: ${t.status} -> ${status}`);
}

function printBoard(tasks) {
  for (const s of STATUSES) {
    const group = tasks.filter((t) => t.status === s);
    if (!group.length) continue;
    console.log(`\n## ${s} (${group.length})`);
    for (const t of group) {
      const deps = t.depends.length ? `  ⟵ ${t.depends.join(', ')}` : '';
      console.log(`  ${t.id}  [P${t.phase}] ${t.title}${deps}`);
    }
  }
  const ready = readyTasks(tasks).map((t) => t.id);
  const earlyOnly = readyTasks(tasks, true).filter((t) => !ready.includes(t.id)).map((t) => t.id);
  console.log(`\nready: ${ready.length ? ready.join(', ') : '(none)'}`);
  if (earlyOnly.length) console.log(`early-start possible: ${earlyOnly.join(', ')}`);
}

const [cmd = 'list', ...args] = process.argv.slice(2);
const json = args.includes('--json');
const early = args.includes('--early');
const positional = args.filter((a) => !a.startsWith('--'));
const tasks = loadTasks();
const out = (v, human) => (json ? console.log(JSON.stringify(v, null, 2)) : human());

switch (cmd) {
  case 'list':
    out(tasks, () => printBoard(tasks));
    break;
  case 'ready': {
    const r = readyTasks(tasks, early);
    out(r, () => r.forEach((t) => console.log(`${t.id}\t${t.title}\towns=${t.owns.join(',')}`)));
    break;
  }
  case 'plan': {
    const p = plan(tasks, Number(positional[0] ?? 4), early);
    out(p, () => p.forEach((t) => console.log(`${t.id}\t${t.file}`)));
    break;
  }
  case 'show': {
    const t = tasks.find((x) => x.id === positional[0]);
    if (!t) {
      console.error(`no task ${positional[0]}`);
      process.exit(1);
    }
    console.log(readFileSync(join(TASK_DIR, t.file), 'utf8'));
    break;
  }
  case 'set':
    setStatus(positional[0], positional[1]);
    break;
  case 'check': {
    const errors = check(tasks);
    if (errors.length) {
      errors.forEach((e) => console.error(`✗ ${e}`));
      process.exit(1);
    }
    console.log(`✓ ${tasks.length} task files valid`);
    break;
  }
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(1);
}
