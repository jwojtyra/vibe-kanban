import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vkHome } from "./paths.js";

let db: DatabaseSync | null = null;

/** Wersja schematu. Starsze bazy (bez zgodnej wersji) są odkładane jako kopia zapasowa. */
const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- globalna lista repozytoriów; ticket wskazuje, których dotyczy
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  base_branch TEXT NOT NULL DEFAULT 'main',
  test_command TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

CREATE TABLE IF NOT EXISTS task_repos (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, repo_id)
);

-- elementy planu: poziom 1 = Etap, 2 = Funkcja, 3 = Krok (wykonywany przez subagenta)
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  next_child INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  problem TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',     -- Funkcja: testy akceptacyjne; Krok: kryteria
  kind TEXT NOT NULL DEFAULT 'impl',       -- Krok: test | impl
  status TEXT NOT NULL DEFAULT 'draft',
  repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  branch TEXT,
  worktree_path TEXT,
  base_ref TEXT,
  agent_session_id TEXT,
  review_session_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  blocker TEXT NOT NULL DEFAULT '',        -- powód zablokowania (pusty = brak)
  log_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS item_deps (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, depends_on_id)
);

-- pytania agenta do człowieka (przy elemencie planu albo przy całym tickecie)
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',      -- propozycje odpowiedzi (JSON)
  blocking INTEGER NOT NULL DEFAULT 0,     -- 1 = bez odpowiedzi nie da się realizować
  status TEXT NOT NULL DEFAULT 'open',     -- open | answered | closed
  answer_choice TEXT,                      -- wybrana propozycja (NULL = odpowiedź własna)
  answer_text TEXT NOT NULL DEFAULT '',    -- odpowiedź własna / uwagi
  note TEXT NOT NULL DEFAULT '',           -- notatka agenta przy zamknięciu
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,            -- global | task
  scope_id INTEGER,               -- NULL dla global
  name TEXT NOT NULL,
  kind TEXT NOT NULL,             -- path | git
  location TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
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

function open(file: string): DatabaseSync {
  const d = new DatabaseSync(file);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return d;
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = path.join(vkHome(), "vk.db");
  let d = open(file);
  const version = (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const hasTables = (d.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get() as { c: number }).c > 0;
  // migracje zgodnych wersji
  if (hasTables && version === 3) {
    const cols = (d.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("blocker")) d.exec("ALTER TABLE items ADD COLUMN blocker TEXT NOT NULL DEFAULT ''");
    d.exec(SCHEMA); // tworzy tabelę questions
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } else if (hasTables && version !== SCHEMA_VERSION) {
    // niezgodna (starsza) baza — odkładamy ją i zaczynamy od nowa
    d.close();
    const backup = `${file}.v${version || 1}-${Date.now()}.bak`;
    fs.renameSync(file, backup);
    for (const ext of ["-wal", "-shm"]) if (fs.existsSync(file + ext)) fs.rmSync(file + ext);
    process.stderr.write(`[vk] Baza w starszym formacie została przeniesiona do ${backup}; utworzono nową.\n`);
    d = open(file);
  }
  d.exec(SCHEMA);
  d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  d.exec("PRAGMA foreign_keys = ON");
  db = d;
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

let depth = 0;

/** Transakcja (zagnieżdżone wywołania działają w ramach zewnętrznej). */
export function tx<T>(fn: () => T): T {
  const d = getDb();
  if (depth > 0) return fn();
  d.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  } finally {
    depth--;
  }
}
