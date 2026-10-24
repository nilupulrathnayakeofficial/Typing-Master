'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT,
      google_id     TEXT UNIQUE,
      avatar        TEXT,
      role          TEXT NOT NULL DEFAULT 'member',
      banned        INTEGER NOT NULL DEFAULT 0,
      signup_ip     TEXT,
      last_ip       TEXT,
      consent_at    INTEGER,
      created_at    INTEGER NOT NULL,
      last_seen     INTEGER
    );

    CREATE TABLE IF NOT EXISTS scores (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wpm        REAL NOT NULL,
      accuracy   REAL NOT NULL,
      duration   INTEGER NOT NULL,
      mode       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id);
    CREATE INDEX IF NOT EXISTS idx_scores_time ON scores(created_at);

    CREATE TABLE IF NOT EXISTS logins (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip         TEXT,
      method     TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logins_user ON logins(user_id, created_at);
  `);
  return db;
}

module.exports = { openDb };
