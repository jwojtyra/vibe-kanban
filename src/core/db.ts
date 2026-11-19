import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vkHome } from "./paths.js";

let db: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  base_branch TEXT NOT NULL DEFAULT 'main',
  assumptions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ticket_url TEXT NOT NULL DEFAULT '',
  ticket_id TEXT NOT NULL DEFAULT '',
  assumptions TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  plan_prompt TEXT,
  impl_prompt TEXT,
  review_prompt TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  plan_session_id TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  key TEXT NOT NULL UNIQUE,
  number INTEGER NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  problem TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  branch TEXT,
  worktree_path TEXT,
  base_ref TEXT,
  agent_session_id TEXT,
  review_session_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  log_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtask_deps (
  subtask_id INTEGER NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
  PRIMARY KEY (subtask_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,            -- global | project | task
  scope_id INTEGER,               -- NULL dla global
  name TEXT NOT NULL,
  kind TEXT NOT NULL,             -- path | git
  location TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subtask_id INTEGER NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
  file TEXT,
  line INTEGER,
  side TEXT,                      -- new | old
  line_text TEXT,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function getDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(path.join(vkHome(), "vk.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

type Param = string | number | null | bigint;

export function all<T>(sql: string, ...params: Param[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: Param[]) {
  return getDb().prepare(sql).run(...params);
}

export function tx<T>(fn: () => T): T {
  const d = getDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
