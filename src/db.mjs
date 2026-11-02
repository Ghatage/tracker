// Single data-access module. Used by server.mjs, cli.mjs and test.mjs.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const STATUSES = ['todo', 'in_progress', 'done'];
export const TYPES = ['story', 'bug', 'research'];
export const DEFAULT_PREFIX = 'TK';
export const DEFAULT_PORT = 4711;
// Per-project state lives in this folder, found by walking up from the working directory like .git/.
export const TRACKER_DIR = '.tracker';

// `theme` is a legacy alias for `themes` with one value, kept for older callers.
const TICKET_FIELDS = ['title', 'description', 'status', 'type', 'epic', 'themes', 'theme', 'labels', 'resolution'];
const AREA_PREFIX = 'area:';
const EPIC_FIELDS = ['name', 'description'];

export class TrackerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new TrackerError(400, msg);
const now = () => new Date().toISOString();

// ---- input normalisation -------------------------------------------------

function normKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z]+-\d+$/.test(key.trim())) throw bad(`invalid ticket key: ${JSON.stringify(key)}`);
  return key.trim().toUpperCase();
}

// Accepts "E3", "3", 3. Returns null for null/''/'none'.
function parseEpicRef(ref) {
  if (ref === null || ref === undefined || ref === '' || ref === 'none') return null;
  const m = /^E?(\d+)$/i.exec(String(ref).trim());
  if (!m) throw bad(`invalid epic id: ${JSON.stringify(ref)} (expected E<n>)`);
  return Number(m[1]);
}
const epicKey = (id) => (id == null ? null : `E${id}`);

function normStatus(s) {
  if (!STATUSES.includes(s)) throw bad(`invalid status: ${JSON.stringify(s)} (expected one of ${STATUSES.join(', ')})`);
  return s;
}

function normType(t) {
  if (!TYPES.includes(t)) throw bad(`invalid type: ${JSON.stringify(t)} (expected one of ${TYPES.join(', ')})`);
  return t;
}

function normTheme(t) {
  if (t === null || t === undefined || t === 'none') return null;
  if (typeof t !== 'string') throw bad('theme must be a string');
  const v = t.trim().toLowerCase();
  return v === '' ? null : v;
}

// Lowercase, trimmed, de-duplicated, order preserved.
function normThemes(themes) {
  if (themes === null || themes === undefined) return [];
  if (!Array.isArray(themes) || !themes.every((t) => typeof t === 'string')) throw bad('themes must be an array of strings');
  return [...new Set(themes.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

// The themes a create or update sets, from `themes` or the legacy `theme`. Undefined when neither is given.
function themesInput(input) {
  if ('themes' in input && 'theme' in input) throw bad('give themes or theme, not both');
  if ('themes' in input) return normThemes(input.themes);
  if ('theme' in input) {
    const t = normTheme(input.theme);
    return t === null ? [] : [t];
  }
  return undefined;
}

// Old data (a `theme` value plus `area:<x>` labels) to new data (`themes`, labels without `area:`).
function convertLegacyTheme(theme, labels, themes = []) {
  const areas = labels.filter((l) => l.startsWith(AREA_PREFIX)).map((l) => l.slice(AREA_PREFIX.length));
  return {
    themes: normThemes([theme ?? '', ...areas, ...themes]),
    labels: labels.filter((l) => !l.startsWith(AREA_PREFIX)),
  };
}

function normLabels(labels) {
  if (labels === null || labels === undefined) return [];
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) throw bad('labels must be an array of strings');
  return [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
}

function normText(v, name, { required = false } = {}) {
  if (v === null || v === undefined) v = '';
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  if (required && v.trim() === '') throw bad(`${name} is required`);
  return required ? v.trim() : v;
}

function rejectUnknown(obj, allowed, what) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad(`${what} must be a JSON object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw bad(`unknown ${what} field: ${k}`);
}

// ---- open ----------------------------------------------------------------

export function openDb(path, { prefix = DEFAULT_PREFIX } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Wait up to 10 s for another writer instead of failing with "database is locked".
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  const tracker = new Tracker(db, prefix);
  tracker.migrate();
  return tracker;
}

// ---- projects ------------------------------------------------------------

// The nearest folder at or above `from` that holds .tracker/config.json, or null.
export function findRoot(from = process.cwd()) {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, TRACKER_DIR, 'config.json'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

// Letters only, because keys must match <letters>-<n>: "my-cool-app" -> "MCA", "notes" -> "NO".
export function prefixFor(name) {
  const words = name.split(/[^A-Za-z]+/).filter(Boolean);
  const p = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] ?? '').slice(0, 2);
  return p.toUpperCase() || DEFAULT_PREFIX;
}

function normPrefix(p) {
  if (typeof p !== 'string' || !/^[A-Za-z]{1,10}$/.test(p.trim())) throw bad(`invalid prefix: ${JSON.stringify(p)} (expected 1-10 letters)`);
  return p.trim().toUpperCase();
}

function normPort(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad(`invalid port: ${JSON.stringify(p)}`);
  return n;
}

// Creates <dir>/.tracker/ with its config and an empty database. Idempotent: an existing config is kept.
export function initProject(dir = process.cwd(), { prefix, port } = {}) {
  const root = resolve(dir);
  const folder = join(root, TRACKER_DIR);
  const configPath = join(folder, 'config.json');
  const created = !existsSync(configPath);
  if (created) {
    const config = { prefix: normPrefix(prefix ?? prefixFor(basename(root))), port: normPort(port ?? DEFAULT_PORT) };
    mkdirSync(folder, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    // The database is personal and binary: keep the whole folder out of the project's git.
    writeFileSync(join(folder, '.gitignore'), '*\n');
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  openDb(join(folder, 'tracker.db'), { prefix: config.prefix }).close();
  return { root, created, prefix: config.prefix, port: config.port };
}

// TRACKER_DB (with TRACKER_PREFIX) names a database directly; otherwise the
// project is found from `from` upwards.
export function openProject(from = process.cwd()) {
  if (process.env.TRACKER_DB) {
    const tracker = openDb(process.env.TRACKER_DB, { prefix: normPrefix(process.env.TRACKER_PREFIX || DEFAULT_PREFIX) });
    return Object.assign(tracker, { root: null, path: process.env.TRACKER_DB, port: DEFAULT_PORT });
  }
  const root = findRoot(from);
  if (!root) throw new TrackerError(404, `no tracker in ${resolve(from)} or any parent folder; run "tracker init" in your project folder first`);
  const config = JSON.parse(readFileSync(join(root, TRACKER_DIR, 'config.json'), 'utf8'));
  const path = join(root, TRACKER_DIR, 'tracker.db');
  const tracker = openDb(path, { prefix: normPrefix(config.prefix) });
  return Object.assign(tracker, { root, path, port: normPort(config.port ?? DEFAULT_PORT) });
}

export class Tracker {
  constructor(db, prefix = DEFAULT_PREFIX) {
    this.db = db;
    this.prefix = prefix;
  }

  close() {
    this.db.close();
  }

  tx(fn) {
    // IMMEDIATE takes the write lock up front, so the busy timeout applies instead of a failed lock upgrade.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- migration ---------------------------------------------------------

  ticketColumns() {
    return new Set(this.db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name));
  }

  // Upgrades a database created by an older schema, in place and idempotently.
  // The column check runs again inside the transaction because another process
  // may have migrated while this one waited for the write lock.
  migrate() {
    const needed = (cols) => !cols.has('themes') || !cols.has('type') || cols.has('theme');
    if (!needed(this.ticketColumns())) return;
    this.tx(() => {
      const cols = this.ticketColumns();
      if (!needed(cols)) return;
      if (!cols.has('themes')) this.db.exec("ALTER TABLE tickets ADD COLUMN themes TEXT NOT NULL DEFAULT '[]'");
      if (!cols.has('type')) {
        this.db.exec(`ALTER TABLE tickets ADD COLUMN type TEXT NOT NULL DEFAULT 'story' CHECK (type IN (${TYPES.map((t) => `'${t}'`).join(', ')}))`);
        this.db.exec("UPDATE tickets SET type = 'story'");
      }
      if (cols.has('theme')) {
        const upd = this.db.prepare('UPDATE tickets SET themes = ?, labels = ? WHERE id = ?');
        for (const r of this.db.prepare('SELECT id, theme, themes, labels FROM tickets').all()) {
          const c = convertLegacyTheme(r.theme, JSON.parse(r.labels), JSON.parse(r.themes));
          upd.run(JSON.stringify(c.themes), JSON.stringify(c.labels), r.id);
        }
        this.db.exec('ALTER TABLE tickets DROP COLUMN theme');
      }
    });
  }

  // ---- internal helpers --------------------------------------------------

  ticketRow(key) {
    const row = this.db.prepare('SELECT * FROM tickets WHERE key = ?').get(normKey(key));
    if (!row) throw new TrackerError(404, `ticket ${normKey(key)} not found`);
    return row;
  }

  epicRow(ref) {
    const id = parseEpicRef(ref);
    const row = id == null ? null : this.db.prepare('SELECT * FROM epics WHERE id = ?').get(id);
    if (!row) throw new TrackerError(404, `epic ${epicKey(id) ?? JSON.stringify(ref)} not found`);
    return row;
  }

  // Resolves an epic reference for writes: null/'none' clears, otherwise must exist.
  epicIdForWrite(ref) {
    const id = parseEpicRef(ref);
    if (id != null && !this.db.prepare('SELECT 1 FROM epics WHERE id = ?').get(id)) throw bad(`epic E${id} not found`);
    return id;
  }

  // All dependency edges with keys and statuses, grouped both ways.
  loadDeps() {
    const rows = this.db.prepare(`
      SELECT d.ticket_id, d.blocked_by_id, t.key AS ticket_key, b.key AS blocker_key, b.status AS blocker_status
      FROM dependencies d
      JOIN tickets t ON t.id = d.ticket_id
      JOIN tickets b ON b.id = d.blocked_by_id
      ORDER BY d.ticket_id, d.blocked_by_id`).all();
    const byTicket = new Map(); // ticket id -> [{key, status}] of its blockers
    const byBlocker = new Map(); // blocker id -> [key] of tickets it blocks
    for (const r of rows) {
      if (!byTicket.has(r.ticket_id)) byTicket.set(r.ticket_id, []);
      byTicket.get(r.ticket_id).push({ key: r.blocker_key, status: r.blocker_status });
      if (!byBlocker.has(r.blocked_by_id)) byBlocker.set(r.blocked_by_id, []);
      byBlocker.get(r.blocked_by_id).push(r.ticket_key);
    }
    return { byTicket, byBlocker };
  }

  shapeTicket(row, deps) {
    const blockers = deps.byTicket.get(row.id) || [];
    return {
      key: row.key,
      title: row.title,
      description: row.description,
      status: row.status,
      type: row.type,
      epic: epicKey(row.epic_id),
      themes: JSON.parse(row.themes),
      labels: JSON.parse(row.labels),
      resolution: row.resolution,
      created_at: row.created_at,
      updated_at: row.updated_at,
      closed_at: row.closed_at,
      blocked: blockers.some((b) => b.status !== 'done'),
      blocked_by: blockers.map((b) => b.key),
      blocks: deps.byBlocker.get(row.id) || [],
    };
  }

  // Would making `ticketId` blocked by `blockerId` create a cycle? True when
  // the blocker already (transitively) depends on the ticket.
  wouldCycle(ticketId, blockerId) {
    return Boolean(this.db.prepare(`
      WITH RECURSIVE up(id) AS (
        SELECT blocked_by_id FROM dependencies WHERE ticket_id = :blocker
        UNION
        SELECT d.blocked_by_id FROM dependencies d JOIN up ON d.ticket_id = up.id
      )
      SELECT 1 FROM up WHERE id = :ticket LIMIT 1`).get({ blocker: blockerId, ticket: ticketId }));
  }

  addDep(ticketRow, blockerKey) {
    const blocker = this.ticketRow(blockerKey);
    if (blocker.id === ticketRow.id) throw bad(`${ticketRow.key} cannot block itself`);
    if (this.wouldCycle(ticketRow.id, blocker.id)) {
      throw bad(`${blocker.key} already depends on ${ticketRow.key}; making ${ticketRow.key} blocked by ${blocker.key} would create a cycle`);
    }
    this.db.prepare('INSERT OR IGNORE INTO dependencies (ticket_id, blocked_by_id) VALUES (?, ?)').run(ticketRow.id, blocker.id);
  }

  // ---- tickets -----------------------------------------------------------

  listTickets(f = {}) {
    const where = [];
    const p = {};
    const add = (clause, name, value) => { where.push(clause); p[name] = value; };
    if (f.status) add('status = :status', 'status', normStatus(f.status));
    if (f.epic !== undefined && f.epic !== null && f.epic !== '') add('epic_id = :epic_id', 'epic_id', parseEpicRef(f.epic));
    if (f.type) add('type = :type', 'type', normType(f.type));
    if (f.theme) add('EXISTS (SELECT 1 FROM json_each(tickets.themes) WHERE value = :theme)', 'theme', normTheme(f.theme));
    if (f.label) add('EXISTS (SELECT 1 FROM json_each(tickets.labels) WHERE value = :label)', 'label', f.label);
    if (f.q) add('(key LIKE :q OR title LIKE :q OR description LIKE :q)', 'q', `%${f.q}%`);
    const sql = `SELECT * FROM tickets${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id`;
    const deps = this.loadDeps();
    let out = this.db.prepare(sql).all(p).map((r) => this.shapeTicket(r, deps));
    if (f.blocked !== undefined && f.blocked !== null && f.blocked !== '') {
      const want = String(f.blocked);
      if (want !== 'true' && want !== 'false') throw bad('blocked must be true or false');
      out = out.filter((t) => t.blocked === (want === 'true'));
    }
    return out;
  }

  getTicket(key) {
    return this.shapeTicket(this.ticketRow(key), this.loadDeps());
  }

  createTicket(input) {
    rejectUnknown(input, [...TICKET_FIELDS, 'blocked_by'], 'ticket');
    const ts = now();
    const status = normStatus(input.status ?? 'todo');
    const row = {
      title: normText(input.title, 'title', { required: true }),
      description: normText(input.description, 'description'),
      status,
      type: normType(input.type ?? 'story'),
      epic_id: this.epicIdForWrite(input.epic),
      themes: JSON.stringify(themesInput(input) ?? []),
      labels: JSON.stringify(normLabels(input.labels)),
      resolution: input.resolution == null ? null : normText(input.resolution, 'resolution'),
      created_at: ts,
      updated_at: ts,
      closed_at: status === 'done' ? ts : null,
    };
    const blockedBy = input.blocked_by ?? [];
    if (!Array.isArray(blockedBy)) throw bad('blocked_by must be an array of ticket keys');
    const key = this.tx(() => {
      const { lastInsertRowid: id } = this.db.prepare(`
        INSERT INTO tickets (title, description, status, type, epic_id, themes, labels, resolution, created_at, updated_at, closed_at)
        VALUES (:title, :description, :status, :type, :epic_id, :themes, :labels, :resolution, :created_at, :updated_at, :closed_at)`).run(row);
      const k = `${this.prefix}-${id}`;
      this.db.prepare('UPDATE tickets SET key = ? WHERE id = ?').run(k, id);
      const created = { id, key: k };
      for (const b of blockedBy) this.addDep(created, b);
      return k;
    });
    return this.getTicket(key);
  }

  updateTicket(key, patch) {
    rejectUnknown(patch, TICKET_FIELDS, 'ticket');
    const row = this.ticketRow(key);
    const set = {};
    if ('title' in patch) set.title = normText(patch.title, 'title', { required: true });
    if ('description' in patch) set.description = normText(patch.description, 'description');
    if ('status' in patch) {
      set.status = normStatus(patch.status);
      if (set.status === 'done' && row.status !== 'done') set.closed_at = now();
      if (set.status !== 'done' && row.status === 'done') set.closed_at = null;
    }
    if ('type' in patch) set.type = normType(patch.type);
    if ('epic' in patch) set.epic_id = this.epicIdForWrite(patch.epic);
    const themes = themesInput(patch);
    if (themes !== undefined) set.themes = JSON.stringify(themes);
    if ('labels' in patch) set.labels = JSON.stringify(normLabels(patch.labels));
    if ('resolution' in patch) set.resolution = patch.resolution == null ? null : normText(patch.resolution, 'resolution');
    if (Object.keys(set).length === 0) throw bad('nothing to update');
    set.updated_at = now();
    const cols = Object.keys(set).map((c) => `${c} = :${c}`).join(', ');
    this.db.prepare(`UPDATE tickets SET ${cols} WHERE id = :id`).run({ ...set, id: row.id });
    return this.getTicket(row.key);
  }

  deleteTicket(key) {
    const row = this.ticketRow(key);
    this.db.prepare('DELETE FROM tickets WHERE id = ?').run(row.id);
    return { deleted: row.key };
  }

  addBlocker(key, blockerKey) {
    const row = this.ticketRow(key);
    this.addDep(row, blockerKey);
    return this.getTicket(row.key);
  }

  removeBlocker(key, blockerKey) {
    const row = this.ticketRow(key);
    const blocker = this.ticketRow(blockerKey);
    const { changes } = this.db.prepare('DELETE FROM dependencies WHERE ticket_id = ? AND blocked_by_id = ?').run(row.id, blocker.id);
    if (!changes) throw new TrackerError(404, `${row.key} is not blocked by ${blocker.key}`);
    return this.getTicket(row.key);
  }

  // Open, unblocked, unclaimed: status todo and no open blockers.
  // Takes filters `{epic, type, theme}`, or an epic id on its own.
  frontier(f = {}) {
    const { epic, type, theme } = f !== null && typeof f === 'object' ? f : { epic: f };
    return this.listTickets({ status: 'todo', epic, type, theme }).filter((t) => !t.blocked);
  }

  // Edges go from blocker to the ticket it blocks. With an epic filter, only
  // edges with both ends inside the epic are returned; `blocked` still counts
  // blockers outside it.
  graph(epic) {
    const tickets = this.listTickets({ epic });
    const keys = new Set(tickets.map((t) => t.key));
    const nodes = tickets.map(({ key, title, status, type, themes, epic, blocked }) => ({ key, title, status, type, themes, epic, blocked }));
    const edges = [];
    for (const t of tickets) for (const b of t.blocked_by) if (keys.has(b)) edges.push({ from: b, to: t.key });
    return { nodes, edges };
  }

  // ---- epics -------------------------------------------------------------

  shapeEpic(row, counts) {
    const c = counts.get(row.id) || {};
    return {
      id: epicKey(row.id),
      name: row.name,
      description: row.description,
      created_at: row.created_at,
      updated_at: row.updated_at,
      counts: { todo: c.todo || 0, in_progress: c.in_progress || 0, done: c.done || 0 },
    };
  }

  epicCounts() {
    const counts = new Map();
    for (const r of this.db.prepare('SELECT epic_id, status, count(*) AS n FROM tickets WHERE epic_id IS NOT NULL GROUP BY epic_id, status').all()) {
      if (!counts.has(r.epic_id)) counts.set(r.epic_id, {});
      counts.get(r.epic_id)[r.status] = r.n;
    }
    return counts;
  }

  listEpics() {
    const counts = this.epicCounts();
    return this.db.prepare('SELECT * FROM epics ORDER BY id').all().map((r) => this.shapeEpic(r, counts));
  }

  getEpic(ref) {
    return this.shapeEpic(this.epicRow(ref), this.epicCounts());
  }

  createEpic(input) {
    rejectUnknown(input, EPIC_FIELDS, 'epic');
    const ts = now();
    const { lastInsertRowid: id } = this.db.prepare('INSERT INTO epics (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(normText(input.name, 'name', { required: true }), normText(input.description, 'description'), ts, ts);
    return this.getEpic(id);
  }

  updateEpic(ref, patch) {
    rejectUnknown(patch, EPIC_FIELDS, 'epic');
    const row = this.epicRow(ref);
    const set = {};
    if ('name' in patch) set.name = normText(patch.name, 'name', { required: true });
    if ('description' in patch) set.description = normText(patch.description, 'description');
    if (Object.keys(set).length === 0) throw bad('nothing to update');
    set.updated_at = now();
    const cols = Object.keys(set).map((c) => `${c} = :${c}`).join(', ');
    this.db.prepare(`UPDATE epics SET ${cols} WHERE id = :id`).run({ ...set, id: row.id });
    return this.getEpic(row.id);
  }

  deleteEpic(ref, force = false) {
    const row = this.epicRow(ref);
    const { n } = this.db.prepare('SELECT count(*) AS n FROM tickets WHERE epic_id = ?').get(row.id);
    if (n > 0 && !force) throw new TrackerError(409, `epic E${row.id} still has ${n} ticket(s); pass force=true to detach them`);
    this.tx(() => {
      this.db.prepare('UPDATE tickets SET epic_id = NULL, updated_at = ? WHERE epic_id = ?').run(now(), row.id);
      this.db.prepare('DELETE FROM epics WHERE id = ?').run(row.id);
    });
    return { deleted: `E${row.id}`, detached_tickets: n };
  }

  themes() {
    return this.db.prepare('SELECT DISTINCT j.value AS theme FROM tickets, json_each(tickets.themes) j ORDER BY 1').all().map((r) => r.theme);
  }

  // ---- export / import ---------------------------------------------------

  // Version 2 has `type` and `themes` on tickets; version 1 had `theme` and `area:` labels.
  exportAll() {
    return {
      version: 2,
      exported_at: now(),
      prefix: this.prefix,
      epics: this.db.prepare('SELECT * FROM epics ORDER BY id').all().map((r) => ({ ...r })),
      tickets: this.db.prepare(`
        SELECT id, key, title, description, status, type, epic_id, themes, labels, resolution, created_at, updated_at, closed_at
        FROM tickets ORDER BY id`).all().map((r) => ({ ...r, themes: JSON.parse(r.themes), labels: JSON.parse(r.labels) })),
      dependencies: this.db.prepare('SELECT ticket_id, blocked_by_id FROM dependencies ORDER BY ticket_id, blocked_by_id').all().map((r) => ({ ...r })),
    };
  }

  // Replaces everything with the dump, atomically. Accepts version 2 dumps and
  // version 1 dumps (a ticket without `themes` is converted like migrate() does).
  importAll(dump) {
    if (!dump || typeof dump !== 'object') throw bad('import body must be a JSON object');
    for (const k of ['epics', 'tickets', 'dependencies']) if (!Array.isArray(dump[k])) throw bad(`import body must have an array "${k}"`);
    const ts = now();
    return this.tx(() => {
      this.db.exec("DELETE FROM dependencies; DELETE FROM tickets; DELETE FROM epics; DELETE FROM sqlite_sequence WHERE name IN ('tickets', 'epics')");
      const insEpic = this.db.prepare('INSERT INTO epics (id, name, description, created_at, updated_at) VALUES (:id, :name, :description, :created_at, :updated_at)');
      for (const e of dump.epics) {
        insEpic.run({ id: e.id, name: normText(e.name, 'epic name', { required: true }), description: normText(e.description, 'description'), created_at: e.created_at ?? ts, updated_at: e.updated_at ?? ts });
      }
      const insTicket = this.db.prepare(`
        INSERT INTO tickets (id, key, title, description, status, type, epic_id, themes, labels, resolution, created_at, updated_at, closed_at)
        VALUES (:id, :key, :title, :description, :status, :type, :epic_id, :themes, :labels, :resolution, :created_at, :updated_at, :closed_at)`);
      const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
      for (const t of dump.tickets) {
        const labels = normLabels(parse(t.labels));
        const c = 'themes' in t ? { themes: normThemes(parse(t.themes)), labels } : convertLegacyTheme(normTheme(t.theme), labels);
        insTicket.run({
          id: t.id,
          key: normKey(t.key),
          title: normText(t.title, 'title', { required: true }),
          description: normText(t.description, 'description'),
          status: normStatus(t.status ?? 'todo'),
          type: normType(t.type ?? 'story'),
          epic_id: t.epic_id ?? null,
          themes: JSON.stringify(c.themes),
          labels: JSON.stringify(c.labels),
          resolution: t.resolution ?? null,
          created_at: t.created_at ?? ts,
          updated_at: t.updated_at ?? ts,
          closed_at: t.closed_at ?? null,
        });
      }
      const insDep = this.db.prepare('INSERT INTO dependencies (ticket_id, blocked_by_id) VALUES (?, ?)');
      for (const d of dump.dependencies) insDep.run(d.ticket_id, d.blocked_by_id);
      const cycle = this.db.prepare(`
        WITH RECURSIVE walk(start, id) AS (
          SELECT ticket_id, blocked_by_id FROM dependencies
          UNION
          SELECT walk.start, d.blocked_by_id FROM dependencies d JOIN walk ON d.ticket_id = walk.id
        )
        SELECT 1 FROM walk WHERE start = id LIMIT 1`).get();
      if (cycle) throw bad('import rejected: dependencies contain a cycle');
      return { imported: { epics: dump.epics.length, tickets: dump.tickets.length, dependencies: dump.dependencies.length } };
    });
  }
}
