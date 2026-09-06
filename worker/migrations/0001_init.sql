-- D1 schema for the DSCM backend.
--
-- Design note: rather than a separate table per record type (users,
-- organizations, parts, purchase orders, invoices, ...), this mirrors the
-- exact shape the app already uses today - one JSON document per logical
-- "file" (data/users.json, data/parts.json, etc.) - stored as a single row
-- each. This keeps every existing route handler's business logic (parsing,
-- validation, filtering) completely unchanged; only the low-level read/write
-- functions swap from "fetch GitHub Contents API" to "read/write this table".
-- `version` replaces GitHub's blob "sha" for optimistic-concurrency checks
-- (a fresh random token is written every update; a write only succeeds if
-- the caller's version still matches what's in the table).

CREATE TABLE IF NOT EXISTS documents (
  path       TEXT PRIMARY KEY,   -- e.g. 'data/users.json', 'data/parts.json'
  content    TEXT NOT NULL,      -- the JSON array/object, exactly as before
  version    TEXT NOT NULL,      -- opaque token, replaces GitHub's "sha"
  updated_at TEXT NOT NULL       -- ISO timestamp, informational only
);
