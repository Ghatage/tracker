// Run: node --no-warnings --test src/test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { DEFAULT_PREFIX as PREFIX, findRoot, initProject, openDb, prefixFor, TrackerError } from './db.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tracker-test-'));
const databases = [];
const track = (db) => { databases.push(db); return db; };
const open = (path) => {
  const tracker = openDb(path);
  track(tracker.db);
  return tracker;
};
const cleanup = (directory, handles, remove = rmSync) => {
  for (const db of handles) if (db.isOpen) db.close();
  remove(directory, { recursive: true, force: true });
};
after(() => cleanup(dir, databases));
let n = 0;
const fresh = () => open(join(dir, `t${n++}.db`));
const keys = (ts) => ts.map((t) => t.key);
const rejects = (fn, status, re) => {
  assert.throws(fn, (e) => e instanceof TrackerError && e.status === status && re.test(e.message), `expected ${status} matching ${re}`);
};

test('epics: create, get by E<n> or n, update, delete refusal and force', () => {
  const db = fresh();
  const e = db.createEpic({ name: 'Capture', description: '## Destination\nfoo' });
  assert.equal(e.id, 'E1');
  assert.equal(db.getEpic('E1').name, 'Capture');
  assert.equal(db.getEpic('1').name, 'Capture');
  assert.equal(db.getEpic(1).name, 'Capture');
  rejects(() => db.getEpic('E9'), 404, /not found/);
  rejects(() => db.createEpic({ name: '' }), 400, /name is required/);
  rejects(() => db.createEpic({ name: 'x', owner: 'me' }), 400, /unknown epic field: owner/);
  assert.equal(db.updateEpic('E1', { description: 'updated' }).description, 'updated');
  db.createTicket({ title: 'a', epic: 'E1' });
  db.createTicket({ title: 'b', epic: 'E1', status: 'done' });
  assert.deepEqual(db.getEpic('E1').counts, { todo: 1, in_progress: 0, done: 1 });
  rejects(() => db.deleteEpic('E1'), 409, /still has 2 ticket/);
  assert.deepEqual(db.deleteEpic('E1', true), { deleted: 'E1', detached_tickets: 2 });
  assert.equal(db.getTicket(`${PREFIX}-1`).epic, null);
  assert.deepEqual(db.listEpics(), []);
});

test('tickets: keys, defaults, normalisation, validation', () => {
  const db = fresh();
  const t = db.createTicket({ title: '  First  ', theme: ' Perf ', labels: ['wayfinder:research', 'wayfinder:research', ' x '] });
  assert.equal(t.key, `${PREFIX}-1`);
  assert.equal(t.title, 'First');
  assert.equal(t.status, 'todo');
  assert.deepEqual(t.themes, ['perf']);
  assert.equal(t.type, 'story');
  assert.equal('theme' in t, false);
  assert.deepEqual(t.labels, ['wayfinder:research', 'x']);
  assert.equal(t.description, '');
  assert.equal(t.closed_at, null);
  assert.equal(t.blocked, false);
  assert.equal(db.createTicket({ title: 'Second' }).key, `${PREFIX}-2`);
  assert.equal(db.getTicket(`${PREFIX.toLowerCase()}-2`).key, `${PREFIX}-2`);
  rejects(() => db.createTicket({ title: '' }), 400, /title is required/);
  rejects(() => db.createTicket({ title: 'x', status: 'open' }), 400, /invalid status/);
  rejects(() => db.createTicket({ title: 'x', epic: 'E7' }), 400, /epic E7 not found/);
  rejects(() => db.createTicket({ title: 'x', assignee: 'me' }), 400, /unknown ticket field: assignee/);
  rejects(() => db.createTicket({ title: 'x', labels: 'a,b' }), 400, /labels must be an array/);
  rejects(() => db.getTicket(`${PREFIX}-99`), 404, /not found/);
  rejects(() => db.getTicket('nope'), 400, /invalid ticket key/);
  rejects(() => db.updateTicket(`${PREFIX}-1`, {}), 400, /nothing to update/);
  assert.deepEqual(db.themes(), ['perf']);
  // deleted keys are never reused
  db.deleteTicket(`${PREFIX}-2`);
  assert.equal(db.createTicket({ title: 'Third' }).key, `${PREFIX}-3`);
});

test('dependencies: blocked derivation, frontier, self and cycle rejection', () => {
  const db = fresh();
  const [a, b, c] = ['A', 'B', 'C'].map((title) => db.createTicket({ title }));
  db.addBlocker(b.key, a.key);
  const cc = db.createTicket({ title: 'C2', blocked_by: [b.key] });
  assert.deepEqual(cc.blocked_by, [b.key]);
  db.addBlocker(c.key, b.key);
  db.addBlocker(c.key, b.key); // idempotent

  assert.deepEqual(keys(db.frontier()), [a.key]);
  assert.equal(db.getTicket(b.key).blocked, true);
  assert.deepEqual(db.getTicket(a.key).blocks, [b.key]);
  assert.deepEqual(db.getTicket(c.key).blocked_by, [b.key]);

  rejects(() => db.addBlocker(a.key, a.key), 400, /cannot block itself/);
  rejects(() => db.addBlocker(a.key, c.key), 400, /would create a cycle/);
  rejects(() => db.addBlocker(a.key, b.key), 400, /would create a cycle/);
  rejects(() => db.removeBlocker(a.key, b.key), 404, /is not blocked by/);

  db.updateTicket(a.key, { status: 'done' });
  assert.equal(db.getTicket(b.key).blocked, false);
  assert.deepEqual(keys(db.frontier()), [b.key]);
  assert.deepEqual(keys(db.listTickets({ blocked: 'true' })), [c.key, cc.key]);
  assert.deepEqual(keys(db.listTickets({ blocked: false })), [a.key, b.key]);

  db.removeBlocker(c.key, b.key);
  assert.deepEqual(keys(db.frontier()), [b.key, c.key]);

  // deleting a ticket cascades its edges
  db.deleteTicket(b.key);
  assert.deepEqual(db.getTicket(cc.key).blocked_by, []);
  assert.equal(db.getTicket(cc.key).blocked, false);
});

test('move and close: claim leaves the frontier, closed_at set and cleared', () => {
  const db = fresh();
  const t = db.createTicket({ title: 'Decide X' });
  assert.deepEqual(keys(db.frontier()), [t.key]);
  const claimed = db.updateTicket(t.key, { status: 'in_progress' });
  assert.equal(claimed.status, 'in_progress');
  assert.deepEqual(db.frontier(), []);
  const closed = db.updateTicket(t.key, { status: 'done', resolution: 'We chose X because Y.' });
  assert.equal(closed.status, 'done');
  assert.equal(closed.resolution, 'We chose X because Y.');
  assert.ok(closed.closed_at);
  const reopened = db.updateTicket(t.key, { status: 'todo' });
  assert.equal(reopened.closed_at, null);
  assert.equal(reopened.resolution, 'We chose X because Y.');
  assert.equal(db.createTicket({ title: 'born done', status: 'done' }).closed_at !== null, true);
});

test('filters and graph', () => {
  const db = fresh();
  const e1 = db.createEpic({ name: 'One' });
  const e2 = db.createEpic({ name: 'Two' });
  const a = db.createTicket({ title: 'Alpha capture', epic: 'E1', theme: 'perf', labels: ['wayfinder:research'] });
  const b = db.createTicket({ title: 'Beta', epic: e1.id, theme: 'ux', blocked_by: [a.key], description: 'needle here' });
  const c = db.createTicket({ title: 'Gamma', epic: e2.id, blocked_by: [b.key] });
  const d = db.createTicket({ title: 'Delta', status: 'in_progress' });

  assert.deepEqual(keys(db.listTickets({ epic: 'E1' })), [a.key, b.key]);
  assert.deepEqual(keys(db.listTickets({ epic: '2' })), [c.key]);
  assert.deepEqual(keys(db.listTickets({ theme: 'PERF' })), [a.key]);
  assert.deepEqual(keys(db.listTickets({ label: 'wayfinder:research' })), [a.key]);
  assert.deepEqual(keys(db.listTickets({ q: 'needle' })), [b.key]);
  assert.deepEqual(keys(db.listTickets({ q: 'alpha' })), [a.key]);
  assert.deepEqual(keys(db.listTickets({ q: a.key })), [a.key]);
  assert.deepEqual(keys(db.listTickets({ status: 'in_progress' })), [d.key]);
  rejects(() => db.listTickets({ status: 'nope' }), 400, /invalid status/);
  rejects(() => db.listTickets({ blocked: 'maybe' }), 400, /blocked must be/);
  assert.deepEqual(keys(db.frontier('E1')), [a.key]);
  assert.deepEqual(db.frontier('E2'), []); // Gamma is blocked by Beta (outside the epic)

  assert.deepEqual(keys(db.frontier({ epic: 'E1', theme: 'ux' })), []);
  const g = db.graph();
  assert.deepEqual(keys(g.nodes), [a.key, b.key, c.key, d.key]);
  assert.deepEqual(g.edges, [{ from: a.key, to: b.key }, { from: b.key, to: c.key }]);
  assert.deepEqual(g.nodes[1], { key: b.key, title: 'Beta', status: 'todo', type: 'story', themes: ['ux'], epic: 'E1', blocked: true });
  const g2 = db.graph('E2');
  assert.deepEqual(keys(g2.nodes), [c.key]);
  assert.deepEqual(g2.edges, []);
  assert.equal(g2.nodes[0].blocked, true);
  assert.deepEqual(db.themes(), ['perf', 'ux']);
});

test('export then import into a fresh db round-trips exactly', () => {
  const src = fresh();
  src.createEpic({ name: 'Map', description: '## Destination\n\nSomewhere.' });
  const a = src.createTicket({ title: 'A', epic: 'E1', theme: 'perf', labels: ['wayfinder:map'] });
  const b = src.createTicket({ title: 'B', epic: 'E1', blocked_by: [a.key], description: 'multi\nline' });
  src.createTicket({ title: 'C', blocked_by: [a.key, b.key] });
  src.updateTicket(a.key, { status: 'done', resolution: 'done because' });
  src.deleteTicket(b.key);
  const dump = src.exportAll();
  assert.equal(dump.version, 2);
  assert.deepEqual(dump.tickets[0].themes, ['perf']);
  assert.equal(dump.tickets[0].type, 'story');
  assert.equal('theme' in dump.tickets[0], false);
  assert.equal(dump.tickets.length, 2);
  assert.equal(dump.dependencies.length, 1);

  const dst = fresh();
  dst.createTicket({ title: 'pre-existing, must vanish' });
  assert.deepEqual(dst.importAll(dump), { imported: { epics: 1, tickets: 2, dependencies: 1 } });
  const again = dst.exportAll();
  const strip = ({ exported_at, ...rest }) => rest;
  assert.deepEqual(strip(again), strip(dump));
  assert.deepEqual(dst.listTickets(), src.listTickets());
  assert.deepEqual(dst.listEpics(), src.listEpics());
  // sequence continues after the highest imported id
  assert.equal(dst.createTicket({ title: 'next' }).key, `${PREFIX}-4`);

  // a bad dump is rejected atomically and leaves data untouched
  const cyclic = structuredClone(again);
  cyclic.dependencies.push({ ticket_id: 1, blocked_by_id: 3 });
  rejects(() => dst.importAll(cyclic), 400, /cycle/);
  assert.equal(dst.listTickets().length, 3);
  rejects(() => dst.importAll({ epics: [], tickets: [{ id: 1, key: 'X-1', title: 'ok' }, { id: 2, key: 'X-2', title: '' }], dependencies: [] }), 400, /title is required/);
  assert.equal(dst.listTickets().length, 3);
  rejects(() => dst.importAll({ epics: [] }), 400, /must have an array/);
});

test('themes: create, replace, clear, legacy theme alias, filter, distinct list', () => {
  const db = fresh();
  const a = db.createTicket({ title: 'A', themes: [' MVP ', 'speakers', 'mvp', ''] });
  assert.deepEqual(a.themes, ['mvp', 'speakers']);
  assert.deepEqual(db.createTicket({ title: 'B' }).themes, []);
  const c = db.createTicket({ title: 'C', theme: 'Perf' }); // legacy alias
  assert.deepEqual(c.themes, ['perf']);
  assert.deepEqual(db.createTicket({ title: 'D', theme: null }).themes, []);
  rejects(() => db.createTicket({ title: 'x', themes: 'a,b' }), 400, /themes must be an array/);
  rejects(() => db.createTicket({ title: 'x', themes: ['a'], theme: 'b' }), 400, /not both/);

  assert.deepEqual(db.updateTicket(a.key, { themes: ['ux', 'speakers'] }).themes, ['ux', 'speakers']);
  assert.deepEqual(db.updateTicket(a.key, { theme: 'notes' }).themes, ['notes']);
  assert.deepEqual(db.updateTicket(a.key, { theme: 'none' }).themes, []);
  assert.deepEqual(db.updateTicket(a.key, { themes: null }).themes, []);
  db.updateTicket(a.key, { themes: ['mvp', 'speakers'] });

  assert.deepEqual(keys(db.listTickets({ theme: 'speakers' })), [a.key]);
  assert.deepEqual(keys(db.listTickets({ theme: 'MVP' })), [a.key]);
  assert.deepEqual(keys(db.listTickets({ theme: 'perf' })), [c.key]);
  assert.deepEqual(keys(db.listTickets({ theme: 'nope' })), []);
  assert.deepEqual(db.themes(), ['mvp', 'perf', 'speakers']);
});

test('type: default, validation, update, filter on list and frontier', () => {
  const db = fresh();
  const s = db.createTicket({ title: 'S' });
  const b = db.createTicket({ title: 'B', type: 'bug' });
  const r = db.createTicket({ title: 'R', type: 'research', blocked_by: [s.key] });
  assert.equal(s.type, 'story');
  assert.equal(b.type, 'bug');
  rejects(() => db.createTicket({ title: 'x', type: 'epic' }), 400, /invalid type/);
  assert.equal(db.createTicket({ title: 'x', type: null }).type, 'story'); // null means default, like status
  rejects(() => db.updateTicket(s.key, { type: 'task' }), 400, /invalid type/);
  rejects(() => db.listTickets({ type: 'task' }), 400, /invalid type/);
  assert.deepEqual(keys(db.listTickets({ type: 'bug' })), [b.key]);
  assert.deepEqual(keys(db.frontier({ type: 'research' })), []); // blocked by S
  db.updateTicket(s.key, { status: 'done' });
  assert.deepEqual(keys(db.frontier({ type: 'research' })), [r.key]);
  assert.equal(db.updateTicket(b.key, { type: 'story' }).type, 'story');
  assert.deepEqual(keys(db.listTickets({ type: 'story' })), [s.key, b.key, `${PREFIX}-4`]);
  assert.deepEqual(db.graph().nodes.map((x) => x.type), ['story', 'story', 'research', 'story']);
});

// The tickets table as it was before themes and type existed.
const OLD_SCHEMA = `
CREATE TABLE epics (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT UNIQUE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  epic_id     INTEGER REFERENCES epics(id) ON DELETE SET NULL,
  theme       TEXT,
  labels      TEXT NOT NULL DEFAULT '[]',
  resolution  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  closed_at   TEXT
);
CREATE TABLE dependencies (
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  blocked_by_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, blocked_by_id),
  CHECK (ticket_id <> blocked_by_id)
);
INSERT INTO epics VALUES (1, 'MVP', 'map', 't0', 't0');
INSERT INTO tickets VALUES
  (1, 'WF-1', 'Pick diarizer', 'body', 'done', 1, 'mvp', '["wayfinder:research","area:speakers"]', 'Chose X', 't1', 't1', 't1'),
  (2, 'WF-2', 'Plain', '', 'todo', NULL, NULL, '[]', NULL, 't2', 't2', NULL),
  (3, 'WF-3', 'Area only', '', 'in_progress', 1, NULL, '["area:ux","keep","area:mvp"]', NULL, 't3', 't3', NULL);
INSERT INTO dependencies VALUES (3, 1);
`;

test('migration: an old-schema database is upgraded in place, once', () => {
  const path = join(dir, `old${n++}.db`);
  const raw = track(new DatabaseSync(path));
  raw.exec(OLD_SCHEMA);
  raw.close();

  const db = open(path);
  const cols = db.db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  assert.ok(cols.includes('themes') && cols.includes('type'));
  assert.ok(!cols.includes('theme'));
  const [t1, t2, t3] = db.listTickets();
  assert.deepEqual([t1.type, t2.type, t3.type], ['story', 'story', 'story']);
  assert.deepEqual(t1.themes, ['mvp', 'speakers']);
  assert.deepEqual(t1.labels, ['wayfinder:research']);
  assert.deepEqual(t2.themes, []);
  assert.deepEqual(t3.themes, ['ux', 'mvp']);
  assert.deepEqual(t3.labels, ['keep']);
  // nothing else changed
  assert.deepEqual([t1.status, t1.resolution, t1.epic, t1.updated_at, t1.description], ['done', 'Chose X', 'E1', 't1', 'body']);
  assert.deepEqual([t3.status, t3.blocked_by], ['in_progress', ['WF-1']]);
  db.updateTicket(t2.key, { type: 'bug' });
  db.close();

  // reopening is a no-op: no rewrite, the bug stays a bug
  const again = open(path);
  assert.equal(again.getTicket('WF-2').type, 'bug');
  assert.deepEqual(again.getTicket('WF-1').themes, ['mvp', 'speakers']);
  assert.equal(again.createTicket({ title: 'new' }).key, `${PREFIX}-4`);
  again.close();
});

test('import accepts an old-format dump with theme and area: labels', () => {
  const old = {
    version: 1,
    epics: [{ id: 1, name: 'MVP', description: '', created_at: 't0', updated_at: 't0' }],
    tickets: [
      { id: 1, key: 'WF-1', title: 'A', description: '', status: 'done', epic_id: 1, theme: 'mvp', labels: ['wayfinder:task', 'area:release'], resolution: 'ok', created_at: 't', updated_at: 't', closed_at: 't' },
      { id: 2, key: 'WF-2', title: 'B', description: '', status: 'todo', epic_id: null, theme: null, labels: '["area:docs"]', resolution: null, created_at: 't', updated_at: 't', closed_at: null },
    ],
    dependencies: [{ ticket_id: 2, blocked_by_id: 1 }],
  };
  const db = fresh();
  db.importAll(old);
  const [a, b] = db.listTickets();
  assert.deepEqual([a.type, a.themes, a.labels, a.resolution], ['story', ['mvp', 'release'], ['wayfinder:task'], 'ok']);
  assert.deepEqual([b.type, b.themes, b.labels, b.blocked_by], ['story', ['docs'], [], ['WF-1']]);
  const dump = db.exportAll();
  assert.equal(dump.version, 2);
  assert.deepEqual(dump.tickets[0].themes, ['mvp', 'release']);
  assert.equal('theme' in dump.tickets[0], false);
  // a new-format dump keeps its labels as they are
  dump.tickets[1].labels = ['area:kept'];
  dump.tickets[1].type = 'bug';
  db.importAll(dump);
  assert.deepEqual([db.getTicket('WF-2').labels, db.getTicket('WF-2').themes, db.getTicket('WF-2').type], [['area:kept'], ['docs'], 'bug']);
  rejects(() => db.importAll({ ...dump, tickets: [{ ...dump.tickets[0], type: 'task' }] }), 400, /invalid type/);
});

test('cli: theme and type flags', () => {
  const path = join(dir, `cli${n++}.db`);
  const cli = (...args) => {
    try {
      return JSON.parse(execFileSync(process.execPath, ['--no-warnings', join(import.meta.dirname, 'cli.mjs'), ...args], { env: { ...process.env, TRACKER_DB: path }, stdio: 'pipe' }));
    } catch (e) {
      return JSON.parse(e.stdout); // failures print {"error"} and exit 1
    }
  };
  const t = cli('create', '--title', 'X', '--theme', 'mvp', '--theme', 'Speakers', '--type', 'research');
  assert.deepEqual([t.themes, t.type], [['mvp', 'speakers'], 'research']);
  assert.deepEqual(cli('create', '--title', 'Y').themes, []);
  assert.deepEqual(cli('update', t.key, '--add-theme', 'ux', '--add-theme', 'mvp').themes, ['mvp', 'speakers', 'ux']);
  assert.deepEqual(cli('update', t.key, '--remove-theme', 'SPEAKERS').themes, ['mvp', 'ux']);
  assert.deepEqual(cli('update', t.key, '--themes', 'notes, perf').themes, ['notes', 'perf']);
  assert.deepEqual(cli('update', t.key, '--themes', 'a,b', '--remove-theme', 'a', '--add-theme', 'c').themes, ['b', 'c']);
  assert.deepEqual(cli('update', t.key, '--theme', 'infra').themes, ['infra']);
  assert.deepEqual(cli('update', t.key, '--theme', 'none').themes, []);
  assert.deepEqual(cli('update', t.key, '--themes', 'x').themes, ['x']);
  assert.deepEqual(cli('update', t.key, '--themes', 'none').themes, []);
  assert.equal(cli('update', t.key, '--type', 'bug').type, 'bug');
  assert.deepEqual(keys(cli('list', '--type', 'bug')), [t.key]);
  assert.deepEqual(keys(cli('frontier', '--type', 'story')), [`${PREFIX}-2`]);
  assert.match(cli('update', t.key, '--type', 'task').error, /invalid type/);
  assert.match(cli('update', t.key, '--themes', 'a', '--theme', 'b').error, /not both/);
  // commands running agents rely on
  const file = join(dir, `desc${n++}.md`);
  writeFileSync(file, '## Goal\n\nnotes');
  assert.equal(cli('update', t.key, '--description-file', file).description, '## Goal\n\nnotes');
  assert.equal(cli('move', t.key, 'in_progress').status, 'in_progress');
  assert.equal(cli('close', t.key, '--resolution-file', file).resolution, '## Goal\n\nnotes');
  assert.equal(cli('get', t.key).status, 'done');
});

test('projects: init, prefix, discovery from a subfolder, CLI without TRACKER_DB', () => {
  assert.equal(prefixFor('my-cool-app'), 'MCA');
  assert.equal(prefixFor('notes'), 'NO');
  assert.equal(prefixFor('2024_ml_hw'), 'MH');
  assert.equal(prefixFor('123'), PREFIX);
  const root = join(dir, `proj${n++}`, 'web-shop');
  const sub = join(root, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  assert.equal(findRoot(sub), null);
  rejects(() => initProject(root, { prefix: 'A-1' }), 400, /invalid prefix/);
  assert.deepEqual(initProject(root), { root, created: true, prefix: 'WS', port: 4711 });
  assert.equal(readFileSync(join(root, '.tracker', '.gitignore'), 'utf8'), '*\n');
  assert.equal(initProject(root, { prefix: 'ZZ' }).created, false, 'init keeps an existing config');
  assert.equal(findRoot(sub), root);
  const env = { ...process.env };
  delete env.TRACKER_DB;
  const cli = (cwd, ...args) => {
    try {
      return JSON.parse(execFileSync(process.execPath, ['--no-warnings', join(import.meta.dirname, 'cli.mjs'), ...args], { cwd, env, stdio: 'pipe' }));
    } catch (e) {
      return JSON.parse(e.stdout);
    }
  };
  assert.equal(cli(sub, 'create', '--title', 'From a subfolder').key, 'WS-1');
  assert.equal(cli(root, 'get', 'ws-1').title, 'From a subfolder');
  const real = realpathSync(root); // macOS: /var is a link to /private/var
  assert.deepEqual(cli(sub, 'where'), { root: real, prefix: 'WS', db: join(real, '.tracker', 'tracker.db'), port: 4711 });
  const outside = mkdtempSync(join(tmpdir(), 'tracker-none-'));
  try {
    assert.match(cli(outside, 'list').error, /run "tracker init"/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('concurrent writers: parallel CLI processes all succeed against one database', async () => {
  const { spawn } = await import('node:child_process');
  const path = join(dir, `concurrent${n++}.db`);
  open(path).close();
  const cli = join(import.meta.dirname, 'cli.mjs');
  const writers = 8, perWriter = 15;
  const run = (w) => new Promise((resolve) => {
    const script = `for (let i = 0; i < ${perWriter}; i++) { const { execFileSync } = require('node:child_process'); execFileSync(process.execPath, ['--no-warnings', ${JSON.stringify(cli)}, 'create', '--title', 'w${w}-' + i], { env: process.env, stdio: 'pipe' }); }`;
    const p = spawn(process.execPath, ['-e', script], { env: { ...process.env, TRACKER_DB: path }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err }));
  });
  const results = await Promise.all(Array.from({ length: writers }, (_, w) => run(w)));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const db = open(path);
  assert.equal(db.listTickets({}).length, writers * perWriter);
  db.close();
});

test('cleanup: close every database before removing its directory', () => {
  const directory = mkdtempSync(join(dir, 'cleanup-'));
  const handles = [0, 1].map((i) => track(new DatabaseSync(join(directory, `${i}.db`))));
  handles[0].close();
  cleanup(directory, handles, (path, options) => {
    // Windows refuses to remove an open SQLite file; enforce that on every host.
    if (handles.some((db) => db.isOpen)) throw Object.assign(new Error('database still open'), { code: 'EPERM' });
    rmSync(path, options);
  });
  assert.ok(handles.every((db) => !db.isOpen));
  assert.equal(existsSync(directory), false);
});

test('Fit keeps a tall epic readable and overflow reachable by panning', async (t) => {
  // jsdom is an optional dev dependency (npm install); the tracker itself has none.
  let JSDOM;
  try {
    ({ JSDOM } = await import('jsdom'));
  } catch {
    return t.skip('jsdom is not installed');
  }
  const tickets = Array.from({ length: 17 }, (_, i) => ({
    key: `WF-${9000 + i}`, title: `Fake graph ticket ${i}`, description: '',
    status: 'todo', type: 'story', epic: 'E1', themes: [], blocked_by: [],
  }));
  const dom = new JSDOM(readFileSync(new URL('./index.html', import.meta.url), 'utf8'), {
    url: 'http://example.com/#graph?epic=E1', runScripts: 'dangerously',
    beforeParse(window) {
      window.fetch = async (path) => ({ ok: true, json: async () => ({
        '/api/tickets': tickets, '/api/epics': [{ id: 'E1', name: 'Fake epic' }], '/api/themes': [],
      })[path] });
      window.SVGElement.prototype.getBoundingClientRect = () => ({ width: 1216, height: 600, left: 32, top: 160 });
    },
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const { window } = dom, doc = window.document;
    const svg = doc.querySelector('#svg'), vp = doc.querySelector('#vp');
    const transform = () => vp.getAttribute('transform').match(/-?[\d.]+/g).map(Number);
    assert.equal(doc.querySelectorAll('.node').length, 17);
    svg.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 500, clientX: 200, clientY: 200, bubbles: true }));
    doc.querySelector('[data-action="fit"]').click();
    const [x, y, scale] = transform();
    assert.ok(parseFloat(window.getComputedStyle(doc.querySelector('.node text.title')).fontSize) * scale >= 12, 'Fit must preserve 12px titles');
    assert.ok(x >= 32 && y >= 32, 'Fit starts overflow at the padded origin');
    svg.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 300, clientY: 500, bubbles: true }));
    window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 300, clientY: -200 }));
    window.dispatchEvent(new window.MouseEvent('mouseup'));
    assert.equal(transform()[1], y - 700, 'drag reaches the bottom of the tall column');
    assert.equal(transform()[2], scale, 'panning preserves readable labels');
    doc.querySelector('[data-action="fit"]').click();
    assert.deepEqual(transform(), [x, y, scale], 'Fit resets the pan');
  } finally {
    dom.window.close();
  }
});
