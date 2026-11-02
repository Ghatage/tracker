# Tracker

A small local ticket tracker for you and your coding agent. Each project gets its own board. You get:

- a `tracker` command (your agent uses it, and you can too),
- a web app with a Kanban board, a dependency graph and epics,
- a skill that teaches Claude Code and Codex how to use the tracker.

All data stays on your computer in one SQLite file. There are no accounts, no npm packages and no build step.

## Install

You need **Node.js 22.15 or newer** (24 LTS is best). Get it from <https://nodejs.org>. Check with `node --version`.

```sh
git clone https://github.com/Ghatage/tracker.git ~/tracker
cd ~/tracker
./install.sh
```

The script does these steps:

1. It makes sure that your Node.js is new enough.
2. It links the `tracker` command into `~/.local/bin`.
3. It links the skill into `~/.claude/skills/tracker` (Claude Code) and `~/.agents/skills/tracker` (Codex and other agents).
4. It runs a smoke test in a temporary folder.
5. If `~/.local/bin` is not on your `PATH`, it tells you the line to add.

The script uses links, not copies. To update, run `git pull` in the clone. If you move the clone, run `./install.sh` again. To remove everything, run `./install.sh --uninstall` (your project boards stay).

Windows: use WSL or Git Bash.

## Use

Make a board once for each project:

```sh
cd my-project
tracker init                 # makes .tracker/ ; keys get a prefix from the folder name, e.g. MP-1
tracker init --prefix SHOP   # or set the prefix yourself
```

`.tracker/` holds `config.json` (prefix and port) and `tracker.db`. It has its own `.gitignore`, so git does not commit it. The command finds `.tracker/` from any subfolder of the project, the same way `git` finds `.git/`.

Then talk to your agent. For example:

- "Use the tracker to plan this feature as tickets with dependencies."
- "What is on the frontier? Claim the first ticket and do it."
- "Close MP-4 with a resolution that says what you changed."

In Claude Code you can also type `/tracker` to load the skill.

To see the board in a browser:

```sh
tracker ui                   # prints the URL, e.g. http://localhost:4711 ; stop with Ctrl+C
```

If the port is in use (for example, another project's board is open), the next free port is used.

## How work flows

1. **Plan.** Make tickets. Group them in an epic (`E1`). Connect them with `block`: `tracker block MP-4 --by MP-3` means MP-4 waits for MP-3.
2. **Pick.** `tracker frontier` lists tickets that are `todo` and not blocked.
3. **Claim.** `tracker move MP-3 in_progress`. Other agent sessions skip claimed tickets.
4. **Close.** `tracker close MP-3 --resolution "..."` records what was decided or done. This unblocks MP-4.

## CLI

`tracker <command> [args]`. Every command prints one JSON value to stdout. On failure it prints `{"error": "..."}` and exits 1. `--description` and `--resolution` also accept `--description-file path` and `--resolution-file path` for long text.

| Command | Example |
|---------|---------|
| `init [--prefix ABC] [--port 4711]` | `tracker init --prefix SHOP` |
| `where` | `tracker where` (project root, prefix, database path, port) |
| `ui [--port N]` | `tracker ui` |
| `create --title "..." [--description "..." \| --description-file p] [--epic E1] [--theme x]... [--type story\|bug\|research] [--label l]... [--blocked-by KEY]... [--status s]` | `tracker create --title "Pick a database" --epic E1 --type research --theme mvp` |
| `get KEY` | `tracker get MP-3` |
| `list [--status s] [--type t] [--epic E1] [--theme x] [--label l] [--q text] [--blocked true\|false]` | `tracker list --epic E1 --status todo` |
| `update KEY [--title] [--description \| --description-file] [--status] [--type t] [--epic E1\|none] [--themes a,b\|none] [--theme x\|none] [--add-theme x]... [--remove-theme x]... [--labels a,b] [--resolution \| --resolution-file]` | `tracker update MP-3 --type bug --add-theme perf` |
| `move KEY todo\|in_progress\|done` | `tracker move MP-3 in_progress` |
| `close KEY --resolution "..." \| --resolution-file p` | `tracker close MP-3 --resolution "Postgres, because we need joins."` |
| `block KEY --by BLOCKER` | `tracker block MP-4 --by MP-3` |
| `unblock KEY --by BLOCKER` | `tracker unblock MP-4 --by MP-3` |
| `delete KEY` | `tracker delete MP-3` |
| `frontier [--epic E1] [--type t] [--theme x]` | `tracker frontier --epic E1` |
| `graph [--epic E1]` | `tracker graph --epic E1` |
| `epic create --name "..." [--description \| --description-file p]` | `tracker epic create --name "Checkout" --description-file plan.md` |
| `epic list` / `epic get E1` | `tracker epic get E1` |
| `epic update E1 [--name] [--description \| --description-file p]` | `tracker epic update E1 --description-file plan.md` |
| `epic delete E1 [--force]` | `tracker epic delete E1 --force` |
| `export [path]` | `tracker export backup.json` (stdout when no path) |
| `import path` | `tracker import backup.json` (replaces everything) |

Themes on `update`: `--themes a,b` replaces the list and `--themes none` clears it. `--add-theme` and `--remove-theme` can be repeated; they apply after any replacement, in one transaction. On `create`, repeat `--theme` for more than one theme.

| Environment variable | Use |
|----------------------|-----|
| `TRACKER_DB` | Use this database file and skip the `.tracker/` search (scripts and tests). |
| `TRACKER_PREFIX` | Key prefix with `TRACKER_DB`. Default `TK`. |
| `TRACKER_PORT` | Port for `tracker ui`. Overrides `config.json`. |
| `TRACKER_BIN_DIR` | Where `install.sh` puts the command. Default `~/.local/bin`. |

## Data model

**Ticket**

| Field         | Notes |
|---------------|-------|
| `key`         | `<PREFIX>-<n>`, given in sequence from 1, never used again. The only name a ticket has. Keys are not case-sensitive on input and are always returned in uppercase. |
| `title`       | required, short |
| `description` | markdown, can be empty |
| `status`      | `todo` (default), `in_progress`, `done` |
| `type`        | `story` (default), `bug`, `research` |
| `epic`        | `E<n>` or null |
| `themes`      | array of lowercase strings (`mvp`, `perf`, `ux`), default `[]`. The first theme sets the color of the graph node. |
| `labels`      | array of strings, default `[]` |
| `resolution`  | the recorded answer when a ticket is closed, or null |
| `created_at`, `updated_at`, `closed_at` | ISO timestamps. `closed_at` is set when status becomes `done` and cleared when the ticket opens again. |

Calculated on every read, not stored:

| Field        | Meaning |
|--------------|---------|
| `blocked_by` | keys of tickets that this ticket waits for |
| `blocks`     | keys of tickets that wait for this ticket |
| `blocked`    | true when a ticket in `blocked_by` is not `done` |

The **frontier** is every `todo` ticket that is not blocked. To claim a ticket, move it to `in_progress`. This removes it from the frontier.

**Epic**: `id` (`E<n>`), `name`, `description` (markdown, can be long), `created_at`, `updated_at`. Responses also have `counts: {todo, in_progress, done}`.

**Dependency**: `(ticket, blocked_by)` pairs. The tracker rejects a ticket that blocks itself and any edge that makes a loop. When you delete a ticket, its edges are also deleted.

There are no owners, assignees, priorities or comments.

## JSON API

`tracker ui` also serves a JSON API on the same port. All responses are JSON. Errors are `{"error": "message"}` with status 400 (bad input), 404 (missing), 405 (wrong method), 409 (conflict) or 413 (body too large). Epic ids can be `E3` or `3`.

| Method   | Path | Body / query |
|----------|------|--------------|
| `GET`    | `/api/health` | `{ok, prefix, root, db}` |
| `GET`    | `/api/tickets` | query: `status`, `type`, `epic`, `theme`, `label`, `q` (text in key, title or description), `blocked` (`true`/`false`) |
| `POST`   | `/api/tickets` | `{title, description?, status?, type?, epic?, themes?, labels?, blocked_by?: [keys]}` → 201 |
| `GET`    | `/api/tickets/:key` | |
| `PATCH`  | `/api/tickets/:key` | any of `title, description, status, type, epic, themes, labels, resolution`. `themes` replaces the list. Unknown fields are rejected. |
| `POST`   | `/api/tickets/:key/move` | `{status}` |
| `DELETE` | `/api/tickets/:key` | |
| `POST`   | `/api/tickets/:key/blocked-by` | `{key}` of the blocker. Safe to repeat. 400 on self or loop. |
| `DELETE` | `/api/tickets/:key/blocked-by/:blocker` | |
| `GET`    | `/api/frontier` | query: `epic`, `type`, `theme` |
| `GET`    | `/api/graph` | query: `epic`. `{nodes: [{key, title, status, type, themes, epic, blocked}], edges: [{from, to}]}`, edge from blocker to blocked |
| `GET`    | `/api/epics` | |
| `POST`   | `/api/epics` | `{name, description?}` → 201 |
| `GET`    | `/api/epics/:id` | |
| `PATCH`  | `/api/epics/:id` | `{name?, description?}` |
| `DELETE` | `/api/epics/:id` | 409 if it still has tickets; `?force=true` deletes it and removes the epic from its tickets |
| `GET`    | `/api/themes` | all themes in use, sorted |
| `GET`    | `/api/export` | full dump `{version: 2, exported_at, prefix, epics, tickets, dependencies}` |
| `POST`   | `/api/import` | a dump; replaces everything in one transaction |

## Layout

```
install.sh       installs the command and the skill
bin/tracker      the command (runs src/cli.mjs)
skill/           the agent skill (SKILL.md, plus agents/openai.yaml for Codex)
src/
  cli.mjs        command line
  server.mjs     web app and JSON API, started by `tracker ui`
  db.mjs         the one data-access module (CLI, server and tests use it)
  schema.sql     tables, applied on every open
  index.html     the web app (plain JS and CSS, no external files)
  test.mjs       tests
```

## Development

```sh
npm test         # node --test; no install needed
```

One UI test needs `jsdom`. Without it, the test is skipped. To run it: `npm install --no-save jsdom && npm test`.

Several processes can write at the same time (SQLite WAL mode with a 10 s busy timeout). This lets more than one agent session use the same board.

## License

Apache License 2.0. See [LICENSE](LICENSE).
