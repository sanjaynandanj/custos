-- Custos telemetry event log.
-- Every column is bounded to short strings; we never store IPs, hostnames,
-- policy contents, tool names, or ledger data.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,   -- server-assigned ISO-8601 UTC timestamp
  install_id  TEXT    NOT NULL,   -- opaque uuid generated on the client
  event       TEXT    NOT NULL,   -- install | demo | proxy | serve | command
  cli_version TEXT    NOT NULL,
  os          TEXT    NOT NULL,   -- linux | darwin | win32 | windows
  runtime     TEXT    NOT NULL    -- node vX.Y.Z or python X.Y.Z
);

CREATE INDEX IF NOT EXISTS idx_events_install ON events(install_id);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_event   ON events(event);
