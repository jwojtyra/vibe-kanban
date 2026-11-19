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
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  assumptions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- repozytoria projektu (np. frontend, backend)
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name),
  UNIQUE (project_id, path)
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
  repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
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

function columns(d: DatabaseSync, table: string): string[] {
  return (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/**
 * Migracja z wersji 0.1 (projekt = jedno repo) do projektu z wieloma repozytoriami:
 * każde dotychczasowe repo staje się repozytorium projektu, podzadania dostają repo_id.
 */
function migrate(d: DatabaseSync) {
  if (!columns(d, "projects").includes("repo_path")) return;
  d.exec("PRAGMA foreign_keys = OFF");
  // nie przepinaj kluczy obcych tasks -> projects na tabelę projects_v1
  d.exec("PRAGMA legacy_alter_table = ON");
  d.exec("BEGIN");
  try {
    d.exec(`
      ALTER TABLE projects RENAME TO projects_v1;
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        assumptions TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO projects(id, name, assumptions, created_at)
        SELECT id, name || CASE WHEN (SELECT COUNT(*) FROM projects_v1 p2 WHERE p2.name = projects_v1.name AND p2.id < projects_v1.id) > 0
                               THEN '-' || id ELSE '' END, assumptions, created_at FROM projects_v1;
    `);
    d.exec(SCHEMA); // tworzy tabelę repos
    d.exec(`
      INSERT INTO repos(project_id, name, path, base_branch)
        SELECT id, 'repo-' || id, repo_path, base_branch FROM projects_v1;
      DROP TABLE projects_v1;
    `);
    // nazwa repozytorium = nazwa katalogu
    for (const r of d.prepare("SELECT id, path FROM repos").all() as { id: number; path: string }[]) {
      d.prepare("UPDATE repos SET name = ? WHERE id = ?").run(path.basename(r.path) || `repo-${r.id}`, r.id);
    }
    if (!columns(d, "subtasks").includes("repo_id")) {
      d.exec("ALTER TABLE subtasks ADD COLUMN repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL");
    }
    d.exec(`UPDATE subtasks SET repo_id = (SELECT r.id FROM repos r JOIN tasks t ON t.project_id = r.project_id
                                            WHERE t.id = subtasks.task_id ORDER BY r.id LIMIT 1)`);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  } finally {
    d.exec("PRAGMA legacy_alter_table = OFF");
    d.exec("PRAGMA foreign_keys = ON");
  }
}

export function getDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(path.join(vkHome(), "vk.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const fresh = (db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'projects'").get() as { c: number }).c === 0;
  if (!fresh) migrate(db);
  db.exec(SCHEMA);
  db.exec("PRAGMA foreign_keys = ON");
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
