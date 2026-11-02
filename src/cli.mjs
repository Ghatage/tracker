#!/usr/bin/env node
// CLI. Talks to the database directly; prints one JSON value to stdout.
import { readFileSync, writeFileSync } from 'node:fs';
import { initProject, openProject, TrackerError } from './db.mjs';
import { serve } from './server.mjs';

const USAGE = `usage: tracker <command> [args]

  init [--prefix ABC] [--port 4711]     create .tracker/ in the current folder (once per project)
  where                                 show the project, prefix and database in use
  ui [--port 4711]                      start the web app (Kanban, graph, epics) for this project

  create --title "..." [--description "..." | --description-file path] [--epic E1] [--theme perf]...
         [--type story|bug|research] [--label x]... [--blocked-by TK-3]... [--status todo]
  get TK-3
  list [--status todo] [--type bug] [--epic E1] [--theme perf] [--label x] [--q text] [--blocked true|false]
  update TK-3 [--title ...] [--description ... | --description-file path] [--status ...] [--type ...]
         [--epic E1|none] [--themes a,b|none] [--theme x|none] [--add-theme x]... [--remove-theme x]...
         [--labels a,b] [--resolution ... | --resolution-file path]
  move TK-3 todo|in_progress|done
  close TK-3 --resolution "..." | --resolution-file path
  block TK-4 --by TK-3
  unblock TK-4 --by TK-3
  delete TK-3
  frontier [--epic E1] [--type research] [--theme x]
  graph [--epic E1]
  epic create --name "..." [--description ... | --description-file path]
  epic list
  epic get E1
  epic update E1 [--name ...] [--description ... | --description-file path]
  epic delete E1 [--force]
  export [path]
  import path`;

const BOOL_FLAGS = new Set(['force']);

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const name = a.slice(2);
    let value = true;
    if (!BOOL_FLAGS.has(name)) {
      if (i + 1 >= argv.length) throw new TrackerError(400, `--${name} needs a value`);
      value = argv[++i];
    }
    opts[name] = name in opts ? [].concat(opts[name], value) : value;
  }
  return { pos, opts };
}

const list = (v) => (v === undefined ? [] : [].concat(v));
const need = (v, what) => {
  if (v === undefined || v === true) throw new TrackerError(400, `missing ${what}`);
  return v;
};
// Option value given inline or via a --<name>-file path. Undefined when neither is present.
function text(opts, name) {
  if (opts[`${name}-file`] !== undefined) return readFileSync(need(opts[`${name}-file`], `--${name}-file path`), 'utf8');
  return opts[name] === undefined ? undefined : need(opts[name], `--${name}`);
}
const splitLabels = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
const one = (v, name) => {
  if (Array.isArray(v)) throw new TrackerError(400, `--${name} may be given only once`);
  return need(v, `--${name}`);
};
// A theme list from --themes a,b or --theme x, where `none` means no themes.
const themeList = (s) => (String(s).trim().toLowerCase() === 'none' ? [] : splitLabels(s));

function ticketPatch(opts) {
  const patch = {};
  if (opts.title !== undefined) patch.title = opts.title;
  const description = text(opts, 'description');
  if (description !== undefined) patch.description = description;
  if (opts.status !== undefined) patch.status = opts.status;
  if (opts.type !== undefined) patch.type = opts.type;
  if (opts.epic !== undefined) patch.epic = opts.epic;
  if (opts.themes !== undefined && opts.theme !== undefined) throw new TrackerError(400, 'give --themes or --theme, not both');
  if (opts.themes !== undefined) patch.themes = themeList(one(opts.themes, 'themes'));
  if (opts.theme !== undefined) patch.themes = themeList(one(opts.theme, 'theme'));
  if (opts.labels !== undefined) patch.labels = splitLabels(opts.labels);
  const resolution = text(opts, 'resolution');
  if (resolution !== undefined) patch.resolution = resolution;
  return patch;
}

// --add-theme and --remove-theme apply to the replacement list if one was given,
// otherwise to the ticket's current themes, read inside the same transaction.
function updateTicket(db, key, opts) {
  const patch = ticketPatch(opts);
  const add = list(opts['add-theme']).map((t) => need(t, '--add-theme'));
  const remove = new Set(list(opts['remove-theme']).map((t) => String(need(t, '--remove-theme')).trim().toLowerCase()));
  if (!add.length && !remove.size) return db.updateTicket(key, patch);
  return db.tx(() => {
    const base = patch.themes ?? db.getTicket(key).themes;
    patch.themes = [...base, ...add].map((t) => t.trim().toLowerCase()).filter((t) => !remove.has(t));
    return db.updateTicket(key, patch);
  });
}

const epicCommands = {
  create: (db, { opts }) => db.createEpic({ name: need(opts.name, '--name'), description: text(opts, 'description') ?? '' }),
  list: (db) => db.listEpics(),
  get: (db, { pos }) => db.getEpic(need(pos[0], 'epic id')),
  update: (db, { pos, opts }) => {
    const patch = {};
    if (opts.name !== undefined) patch.name = opts.name;
    const description = text(opts, 'description');
    if (description !== undefined) patch.description = description;
    return db.updateEpic(need(pos[0], 'epic id'), patch);
  },
  delete: (db, { pos, opts }) => db.deleteEpic(need(pos[0], 'epic id'), opts.force === true),
};

const commands = {
  create: (db, { opts }) => db.createTicket({
    title: need(opts.title, '--title'),
    description: text(opts, 'description') ?? '',
    status: opts.status ?? 'todo',
    type: opts.type ?? 'story',
    epic: opts.epic ?? null,
    themes: list(opts.theme).flatMap(themeList),
    labels: list(opts.label),
    blocked_by: list(opts['blocked-by']),
  }),
  get: (db, { pos }) => db.getTicket(need(pos[0], 'ticket key')),
  list: (db, { opts }) => db.listTickets({ status: opts.status, type: opts.type, epic: opts.epic, theme: opts.theme, label: opts.label, q: opts.q, blocked: opts.blocked }),
  update: (db, { pos, opts }) => updateTicket(db, need(pos[0], 'ticket key'), opts),
  move: (db, { pos }) => db.updateTicket(need(pos[0], 'ticket key'), { status: need(pos[1], 'status') }),
  close: (db, { pos, opts }) => db.updateTicket(need(pos[0], 'ticket key'), { status: 'done', resolution: need(text(opts, 'resolution'), '--resolution') }),
  block: (db, { pos, opts }) => db.addBlocker(need(pos[0], 'ticket key'), need(opts.by, '--by')),
  unblock: (db, { pos, opts }) => db.removeBlocker(need(pos[0], 'ticket key'), need(opts.by, '--by')),
  delete: (db, { pos }) => db.deleteTicket(need(pos[0], 'ticket key')),
  frontier: (db, { opts }) => db.frontier({ epic: opts.epic, type: opts.type, theme: opts.theme }),
  graph: (db, { opts }) => db.graph(opts.epic),
  epic: (db, { pos, opts }) => {
    const sub = epicCommands[pos[0]];
    if (!sub) throw new TrackerError(400, `unknown epic command: ${pos[0] ?? '(none)'}; expected one of ${Object.keys(epicCommands).join(', ')}`);
    return sub(db, { pos: pos.slice(1), opts });
  },
  export: (db, { pos }) => {
    const dump = db.exportAll();
    if (!pos[0]) return dump;
    writeFileSync(pos[0], JSON.stringify(dump, null, 2) + '\n');
    return { exported: pos[0], epics: dump.epics.length, tickets: dump.tickets.length, dependencies: dump.dependencies.length };
  },
  import: (db, { pos }) => db.importAll(JSON.parse(readFileSync(need(pos[0], 'import path'), 'utf8'))),
};

async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    console.error(USAGE);
    return 2;
  }
  if (name === 'init') {
    const { opts } = parseArgs(rest);
    console.log(JSON.stringify(initProject(process.cwd(), { prefix: opts.prefix, port: opts.port }), null, 2));
    return 0;
  }
  if (name === 'ui') {
    const { opts } = parseArgs(rest);
    const db = openProject();
    const port = await serve(db, Number(opts.port ?? process.env.TRACKER_PORT ?? db.port));
    console.log(JSON.stringify({ url: `http://localhost:${port}`, root: db.root, prefix: db.prefix }));
    return 0;
  }
  if (name === 'where') {
    const db = openProject();
    db.close();
    console.log(JSON.stringify({ root: db.root, prefix: db.prefix, db: db.path, port: db.port }, null, 2));
    return 0;
  }
  const command = commands[name];
  if (!command) throw new TrackerError(400, `unknown command: ${name}; expected one of init, where, ui, ${Object.keys(commands).join(', ')}`);
  const db = openProject();
  try {
    console.log(JSON.stringify(command(db, parseArgs(rest)), null, 2));
    return 0;
  } finally {
    db.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
