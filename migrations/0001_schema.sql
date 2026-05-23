CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_addresses_token ON addresses(token);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  date_header TEXT NOT NULL DEFAULT '',
  message_id TEXT UNIQUE,
  body TEXT NOT NULL DEFAULT '',
  raw_excerpt TEXT NOT NULL DEFAULT '',
  raw_truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_recipient_created
  ON messages(recipient, created_at DESC);
