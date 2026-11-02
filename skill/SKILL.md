---
name: tracker
description: Record and work tickets on the local tracker (the `tracker` command), so every piece of work has a key like ABC-3, a claim, dependencies and a recorded resolution. Use when the user asks to plan work, make or update tickets, find the next task, or record what was done.
---

The `tracker` command is a local ticket tracker. Each project has its own board in a `.tracker/` folder. The command finds `.tracker/` from the current folder upwards, the same way `git` finds `.git/`. It works offline and needs no server.

Every command prints one JSON value to stdout. On failure it prints `{"error": "..."}` and exits 1. Run `tracker help` for the full list of commands.

## Start

```sh
tracker where     # shows the project root, the key prefix and the database
```

If `where` gives the error `no tracker in ...`, this project has no board yet. Ask the user before you run `tracker init` in the project root. `init` makes `.tracker/` (git ignores it) and picks a key prefix from the folder name. To set the prefix, use `tracker init --prefix ABC`.

The user can see the board in a browser with `tracker ui` (Kanban, dependency graph, epics). Do not start the UI yourself unless the user asks; it runs until stopped.

## Naming rules

- Refer to a ticket only by its key (`ABC-3`) and its title. Do not make up other names, numbers or slugs.
- Do not use phases, slices, sub-tickets or lettered hierarchies. More work means more tickets plus dependencies.
- Every ticket has a type: `story` (the default, work to build), `bug` (something broken), or `research` (a question to answer).
- Epics (`E1`) group work. Themes (`mvp`, `perf`, `ux`) tag concerns that cross epics; give each ticket one or more. Labels hold anything else.

## When to make a ticket

Make a ticket when a unit of work or a decision must stay after this session: work that a later session will do, work the user wants to see on the board, or a question that another ticket depends on. Do not make tickets for steps that you will finish in the next few minutes.

```sh
tracker create --title "Pick a storage format" --epic E1 --type research --theme mvp --description-file question.md
```

Add dependencies after the two tickets exist (create first, then connect):

```sh
tracker block ABC-4 --by ABC-3      # ABC-4 waits for ABC-3
tracker unblock ABC-4 --by ABC-3
```

The tracker rejects a ticket that blocks itself and any loop of dependencies.

## Claim before you work

Find the work that is ready, then claim it before you do other work. `in_progress` is the claim; other sessions skip it.

```sh
tracker frontier --epic E1           # open, not blocked, not claimed; take the first
tracker move ABC-3 in_progress       # claim
tracker get ABC-3                    # full description, blockers, resolution
```

## Close with a resolution

The resolution records the answer or the result. Always give one. A bare `move ABC-3 done` loses the reason.

```sh
tracker close ABC-3 --resolution "JSONL, because it streams and diffs well."
tracker close ABC-3 --resolution-file answer.md
```

If a ticket is out of scope, close it with a resolution that starts with `Out of scope:`.

## Other commands

```sh
tracker list --epic E1 --status todo
tracker list --theme perf --type bug --blocked false
tracker update ABC-3 --title "..." --labels needs-review,frontend
tracker update ABC-3 --type bug --add-theme perf --remove-theme ux
tracker update ABC-3 --themes mvp,perf        # replace; --themes none clears
tracker graph --epic E1                        # {nodes, edges}, edge goes from blocker to blocked
tracker epic create --name "Checkout flow" --description-file plan.md
tracker epic list
tracker epic get E1
tracker epic update E1 --description-file plan.md
tracker export backup.json                     # full JSON dump; `tracker import backup.json` restores it
```

Use `--description-file` and `--resolution-file` for long or multi-line text. This prevents shell quoting errors.
