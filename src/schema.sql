-- Applied idempotently by db.mjs on every open. Existing databases are
-- upgraded by migrate() in db.mjs; nothing here may reference a column that
-- an older database lacks.

CREATE TABLE IF NOT EXISTS epics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT UNIQUE,                     -- <PREFIX>-<id>, set right after insert
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  type        TEXT NOT NULL DEFAULT 'story' CHECK (type IN ('story', 'bug', 'research')),
  epic_id     INTEGER REFERENCES epics(id) ON DELETE SET NULL,
  themes      TEXT NOT NULL DEFAULT '[]',      -- JSON array of lowercase strings
  labels      TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
  resolution  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  closed_at   TEXT
);

CREATE TABLE IF NOT EXISTS dependencies (
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  blocked_by_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, blocked_by_id),
  CHECK (ticket_id <> blocked_by_id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_epic ON tickets(epic_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_blocked_by ON dependencies(blocked_by_id);
