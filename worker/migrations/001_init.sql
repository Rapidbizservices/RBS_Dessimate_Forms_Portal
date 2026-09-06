CREATE TABLE IF NOT EXISTS documents (
  path       TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  version    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
