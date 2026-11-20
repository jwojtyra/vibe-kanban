import { randomUUID } from "node:crypto";
import { all, get, run, tx } from "./db.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

/** Status Kroku (poziom 3). Etap i Funkcja mają zapisany tylko draft/todo, resztę wyliczamy. */
export type ItemStatus = "draft" | "todo" | "in_progress" | "review" | "done" | "blocked";
export const ITEM_STATUSES: ItemStatus[] = ["draft", "todo", "in_progress", "review", "done", "blocked"];

export const LEVEL = { STAGE: 1, FEATURE: 2, STEP: 3 } as const;
export const LEVEL_NAME: Record<number, string> = { 1: "Etap", 2: "Funkcja", 3: "Krok" };

export interface Repo {
  id: number;
  name: string;
  path: string;
  base_branch: string;
  test_command: string;
  description: string;
  created_at: string;
}

export interface Link {
  url: string;
  note?: string;
}

export interface Task {
  id: number;
  key: string;
  title: string;
  description: string;
  ticket_url: string;
  ticket_id: string;
  assumptions: string;
  links: Link[];
  plan_prompt: string | null;
  impl_prompt: string | null;
  review_prompt: string | null;
  status: string;
  plan_session_id: string;
  next_number: number;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: number;
  task_id: number;
  parent_id: number | null;
  level: number;
  key: string;
  position: number;
  next_child: number;
  title: string;
  description: string;
  problem: string;
  acceptance: string;
  kind: "test" | "impl";
  status: ItemStatus;
  repo_id: number | null;
  repo: string | null; // nazwa repozytorium (Krok)
  branch: string | null;
  worktree_path: string | null;
  base_ref: string | null;
  agent_session_id: string | null;
  review_session_id: string | null;
  summary: string;
  error: string;
  blocker: string; // powód zablokowania (pusty = brak)
  log_path: string | null;
  created_at: string;
  updated_at: string;
  depends_on: string[]; // klucze elementów tego samego poziomu
}

export interface Question {
  id: number;
  task_id: number;
  item_id: number | null;
  item_key: string | null;
  question: string;
  options: string[];
  blocking: boolean;
  status: "open" | "answered" | "closed";
  answer_choice: string | null;
  answer_text: string;
  note: string;
  created_at: string;
  answered_at: string | null;
}

export interface Resource {
  id: number;
  scope: "global" | "task";
  scope_id: number | null;
  name: string;
  kind: "path" | "git";
  location: string;
  note: string;
}

export interface Comment {
  id: number;
  item_id: number;
  file: string | null;
  line: number | null;
  side: string | null;
  line_text: string | null;
  body: string;
  resolved: number;
  resolution: string;
  created_at: string;
}

export class VkError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// ---------- settings ----------

export function getSettings(): Record<string, string> {
  const rows = all<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function updateSettings(values: Record<string, string>) {
  tx(() => {
    for (const [k, v] of Object.entries(values)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      // pusta wartość pola z niepustym domyślnym = powrót do wartości domyślnej
      if (String(v) === "" && DEFAULT_SETTINGS[k] !== "") {
        run("DELETE FROM settings WHERE key = ?", k);
        continue;
      }
      run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, String(v));
    }
  });
}

// ---------- repos (globalna lista) ----------

export function listRepos(): Repo[] {
  return all<Repo>("SELECT * FROM repos ORDER BY name");
}

export function getRepo(id: number): Repo {
  const r = get<Repo>("SELECT * FROM repos WHERE id = ?", id);
  if (!r) throw new VkError(`Brak repozytorium ${id}`, 404);
  return r;
}

/** Repozytorium po nazwie, ID lub ścieżce. */
export function findRepo(ref: string | number): Repo {
  const s = String(ref).trim();
  const r =
    get<Repo>("SELECT * FROM repos WHERE name = ?", s) ??
    get<Repo>("SELECT * FROM repos WHERE path = ?", s.replace(/\/+$/, "")) ??
    (/^\d+$/.test(s) ? get<Repo>("SELECT * FROM repos WHERE id = ?", Number(s)) : undefined);
  if (!r) throw new VkError(`Brak repozytorium "${s}". Znane: ${listRepos().map((x) => x.name).join(", ") || "(brak)"}`, 404);
  return r;
}

export function createRepo(data: { name?: string; path: string; base_branch: string; test_command?: string; description?: string }): Repo {
  const name = (data.name?.trim() || data.path.split("/").filter(Boolean).pop() || "repo").replace(/\s+/g, "-");
  if (get("SELECT 1 FROM repos WHERE name = ?", name)) throw new VkError(`Repozytorium o nazwie "${name}" już istnieje`);
  if (get("SELECT 1 FROM repos WHERE path = ?", data.path)) throw new VkError(`Repozytorium ${data.path} już jest na liście`);
  const r = run(
    "INSERT INTO repos(name, path, base_branch, test_command, description) VALUES(?, ?, ?, ?, ?)",
    name,
    data.path,
    data.base_branch,
    data.test_command ?? "",
    data.description ?? "",
  );
  return getRepo(Number(r.lastInsertRowid));
}

export function updateRepo(id: number, data: Partial<Pick<Repo, "name" | "base_branch" | "test_command" | "description">>) {
  const r = getRepo(id);
  run(
    "UPDATE repos SET name = ?, base_branch = ?, test_command = ?, description = ? WHERE id = ?",
    data.name?.trim() || r.name,
    data.base_branch?.trim() || r.base_branch,
    data.test_command ?? r.test_command,
    data.description ?? r.description,
    id,
  );
  return getRepo(id);
}

export function deleteRepo(id: number) {
  const used = get<{ c: number }>("SELECT COUNT(*) AS c FROM items WHERE repo_id = ? AND status IN ('in_progress', 'review', 'blocked')", id);
  if (used && used.c > 0) throw new VkError("Repozytorium ma Kroki w trakcie lub w review — najpierw je zakończ");
  run("DELETE FROM repos WHERE id = ?", id);
}

// ---------- tasks ----------

type TaskRow = Omit<Task, "links"> & { links: string };

function toTask(r: TaskRow): Task {
  let links: Link[] = [];
  try {
    links = JSON.parse(r.links);
  } catch {
    links = [];
  }
  return { ...r, links };
}

/** Wyciąga ID ticketu z linku (Jira: /browse/PROJ-123, selectedIssue=PROJ-123; GitHub/GitLab: issues/123). */
export function extractTicketId(url: string): string {
  const u = url.trim();
  if (!u) return "";
  const jira = u.match(/(?:browse\/|selectedIssue=|issues\/)([A-Z][A-Z0-9_]+-\d+)/) || u.match(/\b([A-Z][A-Z0-9_]+-\d+)\b/);
  if (jira) return jira[1];
  const gh = u.match(/\/([^/]+)\/(?:-\/)?issues\/(\d+)/);
  if (gh) return `${gh[1].toUpperCase().replace(/[^A-Z0-9]/g, "")}-${gh[2]}`;
  return "";
}

function uniqueTaskKey(base: string): string {
  let key = base;
  let i = 2;
  while (get("SELECT 1 FROM tasks WHERE key = ?", key)) key = `${base}-v${i++}`;
  return key;
}

export function listTasks(): Task[] {
  return all<TaskRow>("SELECT * FROM tasks ORDER BY created_at DESC, id DESC").map(toTask);
}

export function getTask(id: number): Task {
  const r = get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
  if (!r) throw new VkError(`Brak zadania ${id}`, 404);
  return toTask(r);
}

export function getTaskByKey(key: string): Task {
  const r = get<TaskRow>("SELECT * FROM tasks WHERE key = ?", key);
  if (!r) throw new VkError(`Brak zadania o kluczu ${key}`, 404);
  return toTask(r);
}

export function createTask(data: {
  title?: string;
  description?: string;
  ticket_url?: string;
  assumptions?: string;
  links?: Link[];
  repos?: (string | number)[];
}): Task {
  return tx(() => {
    const ticketId = extractTicketId(data.ticket_url ?? "");
    let baseKey = ticketId;
    if (!baseKey) {
      const n = (get<{ c: number }>("SELECT COUNT(*) AS c FROM tasks")?.c ?? 0) + 1;
      baseKey = `VK-${n}`;
    }
    const key = uniqueTaskKey(baseKey);
    const r = run(
      `INSERT INTO tasks(key, title, description, ticket_url, ticket_id, assumptions, links, plan_session_id)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      key,
      data.title?.trim() || ticketId || "Nowe zadanie",
      data.description ?? "",
      data.ticket_url ?? "",
      ticketId,
      data.assumptions ?? "",
      JSON.stringify(data.links ?? []),
      randomUUID(),
    );
    const id = Number(r.lastInsertRowid);
    for (const ref of data.repos ?? []) attachRepo(id, ref);
    return getTask(id);
  });
}

export function updateTask(
  id: number,
  data: Partial<Pick<Task, "title" | "description" | "ticket_url" | "assumptions" | "links" | "plan_prompt" | "impl_prompt" | "review_prompt" | "status">>,
): Task {
  const t = getTask(id);
  const ticketUrl = data.ticket_url ?? t.ticket_url;
  const ticketId = data.ticket_url !== undefined ? extractTicketId(ticketUrl) : t.ticket_id;
  const norm = (v: string | null | undefined, cur: string | null) => (v === undefined ? cur : v && v.trim() ? v : null);
  run(
    `UPDATE tasks SET title = ?, description = ?, ticket_url = ?, ticket_id = ?, assumptions = ?, links = ?,
       plan_prompt = ?, impl_prompt = ?, review_prompt = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
    data.title ?? t.title,
    data.description ?? t.description,
    ticketUrl,
    ticketId,
    data.assumptions ?? t.assumptions,
    JSON.stringify(data.links ?? t.links),
    norm(data.plan_prompt, t.plan_prompt),
    norm(data.impl_prompt, t.impl_prompt),
    norm(data.review_prompt, t.review_prompt),
    data.status ?? t.status,
    id,
  );
  return getTask(id);
}

export function deleteTask(id: number) {
  run("DELETE FROM resources WHERE scope = 'task' AND scope_id = ?", id);
  run("DELETE FROM tasks WHERE id = ?", id);
}

// ---------- repozytoria ticketu ----------

export function listTaskRepos(taskId: number): Repo[] {
  return all<Repo>("SELECT r.* FROM repos r JOIN task_repos tr ON tr.repo_id = r.id WHERE tr.task_id = ? ORDER BY r.name", taskId);
}

export function attachRepo(taskId: number, ref: string | number): Repo {
  const repo = findRepo(ref);
  run("INSERT OR IGNORE INTO task_repos(task_id, repo_id) VALUES(?, ?)", taskId, repo.id);
  return repo;
}

export function detachRepo(taskId: number, repoId: number) {
  const used = get<{ c: number }>("SELECT COUNT(*) AS c FROM items WHERE task_id = ? AND repo_id = ?", taskId, repoId);
  if (used && used.c > 0) throw new VkError("W tym repozytorium są Kroki tego zadania — najpierw je usuń lub przenieś");
  run("DELETE FROM task_repos WHERE task_id = ? AND repo_id = ?", taskId, repoId);
}

// ---------- elementy planu (Etap / Funkcja / Krok) ----------

type ItemRow = Omit<Item, "depends_on" | "repo">;

function hydrate(rows: ItemRow[]): Item[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const deps = all<{ item_id: number; key: string }>(
    `SELECT d.item_id, i.key FROM item_deps d JOIN items i ON i.id = d.depends_on_id
     WHERE d.item_id IN (${ids.map(() => "?").join(",")}) ORDER BY i.key`,
    ...ids,
  );
  const repoNames = new Map(all<{ id: number; name: string }>("SELECT id, name FROM repos").map((r) => [r.id, r.name]));
  return rows.map((r) => ({
    ...r,
    repo: r.repo_id != null ? (repoNames.get(r.repo_id) ?? null) : null,
    depends_on: deps.filter((d) => d.item_id === r.id).map((d) => d.key),
  }));
}

/** Wszystkie elementy zadania w kolejności drzewa (Etap, jego Funkcje, ich Kroki, ...). */
export function listItems(taskId: number): Item[] {
  const items = hydrate(all<ItemRow>("SELECT * FROM items WHERE task_id = ?", taskId));
  const byId = new Map(items.map((i) => [i.id, i]));
  const path = (i: Item): number[] => (i.parent_id && byId.has(i.parent_id) ? [...path(byId.get(i.parent_id)!), i.position] : [i.position]);
  const keyed = items.map((i) => ({ i, p: path(i) }));
  keyed.sort((a, b) => {
    for (let k = 0; k < Math.max(a.p.length, b.p.length); k++) {
      const x = a.p[k] ?? -1;
      const y = b.p[k] ?? -1;
      if (x !== y) return x - y;
    }
    return 0;
  });
  return keyed.map((k) => k.i);
}

export function listSteps(taskId: number): Item[] {
  return listItems(taskId).filter((i) => i.level === LEVEL.STEP);
}

export function getItem(id: number): Item {
  const r = get<ItemRow>("SELECT * FROM items WHERE id = ?", id);
  if (!r) throw new VkError(`Brak elementu ${id}`, 404);
  return hydrate([r])[0];
}

export function getItemByKey(key: string): Item {
  const r = get<ItemRow>("SELECT * FROM items WHERE key = ?", key);
  if (!r) throw new VkError(`Brak elementu o kluczu ${key}`, 404);
  return hydrate([r])[0];
}

/** Element zadania po pełnym kluczu ("SHOP-1-2.1") lub krótkim ("2.1"). */
export function resolveItemRef(taskId: number, ref: string | number): Item {
  const s = String(ref).trim();
  const t = getTask(taskId);
  const row =
    get<ItemRow>("SELECT * FROM items WHERE task_id = ? AND key = ?", taskId, s) ??
    get<ItemRow>("SELECT * FROM items WHERE task_id = ? AND key = ?", taskId, `${t.key}-${s}`);
  if (!row) throw new VkError(`Brak elementu "${s}" w zadaniu ${t.key}`, 404);
  return hydrate([row])[0];
}

export function childrenOf(items: Item[], id: number | null): Item[] {
  return items.filter((i) => i.parent_id === id);
}

/** Kroki (poziom 3) w poddrzewie elementu (dla Kroku — on sam). */
export function stepsUnder(items: Item[], item: Item): Item[] {
  if (item.level === LEVEL.STEP) return [item];
  return childrenOf(items, item.id).flatMap((c) => stepsUnder(items, c));
}

function ancestors(items: Item[], item: Item): Item[] {
  const out: Item[] = [];
  let cur = item.parent_id ? items.find((i) => i.id === item.parent_id) : undefined;
  while (cur) {
    out.push(cur);
    cur = cur.parent_id ? items.find((i) => i.id === cur!.parent_id) : undefined;
  }
  return out;
}

/**
 * Efektywne zależności Kroku: jego własne zależności oraz wszystkie Kroki
 * Funkcji/Etapów, od których zależy jego Funkcja lub Etap.
 */
export function effectiveDeps(items: Item[], step: Item): Item[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const out = new Map<number, Item>();
  for (const el of [step, ...ancestors(items, step)]) {
    for (const k of el.depends_on) {
      const d = byKey.get(k);
      if (d) for (const s of stepsUnder(items, d)) out.set(s.id, s);
    }
  }
  out.delete(step.id);
  return [...out.values()];
}

/** Status wyliczany dla Etapu/Funkcji z ich Kroków. */
export function derivedStatus(items: Item[], item: Item): ItemStatus {
  if (item.level === LEVEL.STEP) return item.status;
  if (item.status === "draft") return "draft";
  const st = stepsUnder(items, item).map((s) => s.status);
  if (st.length === 0) return "todo";
  if (st.every((s) => s === "done")) return "done";
  if (st.some((s) => s === "blocked")) return "blocked";
  if (st.some((s) => s === "in_progress")) return "in_progress";
  if (st.every((s) => s === "review" || s === "done")) return "review";
  if (st.some((s) => s === "review" || s === "done")) return "in_progress";
  return "todo";
}

export interface ItemInput {
  parent?: string | number | null; // klucz rodzica (wymagany dla Funkcji i Kroku)
  repo?: string | number | null; // Krok: repozytorium
  kind?: "test" | "impl";
  title?: string;
  description?: string;
  problem?: string;
  acceptance?: string;
  position?: number;
  depends_on?: (string | number)[];
}

/** Ustawia zależności (tylko między elementami tego samego poziomu) i sprawdza, czy nie powstał cykl. */
function setDeps(taskId: number, item: Item, refs: (string | number)[]) {
  const deps = refs.map((r) => resolveItemRef(taskId, r));
  for (const d of deps) {
    if (d.id === item.id) throw new VkError("Element nie może zależeć od samego siebie");
    if (d.level !== item.level) {
      throw new VkError(`${item.key} (${LEVEL_NAME[item.level]}) może zależeć tylko od elementów tego samego poziomu — ${d.key} to ${LEVEL_NAME[d.level]}`);
    }
  }
  run("DELETE FROM item_deps WHERE item_id = ?", item.id);
  for (const d of new Set(deps.map((x) => x.id))) run("INSERT INTO item_deps(item_id, depends_on_id) VALUES(?, ?)", item.id, d);
  assertNoCycles(taskId);
}

/** Cykl w efektywnych zależnościach Kroków oznaczałby zakleszczenie realizacji. */
function assertNoCycles(taskId: number) {
  const items = listItems(taskId);
  const graph = new Map(items.filter((i) => i.level === LEVEL.STEP).map((s) => [s.id, effectiveDeps(items, s).map((d) => d.id)]));
  const state = new Map<number, 1 | 2>();
  const visit = (n: number) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) throw new VkError("Zależności tworzą cykl (uwzględniając zależności Funkcji i Etapów)");
    state.set(n, 1);
    for (const m of graph.get(n) ?? []) visit(m);
    state.set(n, 2);
  };
  for (const n of graph.keys()) visit(n);
  // cykle między samymi Etapami/Funkcjami (np. bez Kroków)
  for (const lvl of [LEVEL.STAGE, LEVEL.FEATURE]) {
    const g = new Map(items.filter((i) => i.level === lvl).map((i) => [i.key, i.depends_on]));
    const st = new Map<string, 1 | 2>();
    const v = (k: string) => {
      if (st.get(k) === 2) return;
      if (st.get(k) === 1) throw new VkError("Zależności tworzą cykl");
      st.set(k, 1);
      for (const m of g.get(k) ?? []) v(m);
      st.set(k, 2);
    };
    for (const k of g.keys()) v(k);
  }
}

function pickRepoForStep(taskId: number, ref: ItemInput["repo"]) {
  if (ref !== undefined && ref !== null && String(ref).trim() !== "") return attachRepo(taskId, ref); // dołącz do ticketu, jeśli trzeba
  const repos = listTaskRepos(taskId);
  if (repos.length === 1) return repos[0];
  if (repos.length === 0) throw new VkError("Ticket nie ma repozytoriów — dodaj repo (UI, API lub vk_attach_repo)");
  throw new VkError(`Ticket ma kilka repozytoriów — wskaż repo Kroku: ${repos.map((r) => r.name).join(", ")}`);
}

export function createItem(taskId: number, level: number, data: ItemInput, status: ItemStatus = "draft"): Item {
  return tx(() => {
    const t = getTask(taskId);
    let parent: Item | null = null;
    if (level > LEVEL.STAGE) {
      if (data.parent === undefined || data.parent === null || data.parent === "") {
        throw new VkError(`${LEVEL_NAME[level]} wymaga rodzica (${LEVEL_NAME[level - 1]})`);
      }
      parent = resolveItemRef(taskId, data.parent);
      if (parent.level !== level - 1) throw new VkError(`Rodzicem elementu typu ${LEVEL_NAME[level]} musi być ${LEVEL_NAME[level - 1]}, a ${parent.key} to ${LEVEL_NAME[parent.level]}`);
    }
    const repo = level === LEVEL.STEP ? pickRepoForStep(taskId, data.repo) : null;
    const n = parent ? parent.next_child : t.next_number;
    const key = parent ? `${parent.key}.${n}` : `${t.key}-${n}`;
    const siblingsMax =
      get<{ m: number | null }>(
        `SELECT MAX(position) AS m FROM items WHERE task_id = ? AND ${parent ? "parent_id = ?" : "parent_id IS NULL"}`,
        ...(parent ? [taskId, parent.id] : [taskId]),
      )?.m ?? 0;
    const position = data.position ?? siblingsMax + 1;
    if (data.position !== undefined) {
      run(
        `UPDATE items SET position = position + 1 WHERE task_id = ? AND ${parent ? "parent_id = ?" : "parent_id IS NULL"} AND position >= ?`,
        ...(parent ? [taskId, parent.id, position] : [taskId, position]),
      );
    }
    const r = run(
      `INSERT INTO items(task_id, parent_id, level, key, position, title, description, problem, acceptance, kind, status, repo_id)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      taskId,
      parent?.id ?? null,
      level,
      key,
      position,
      data.title?.trim() || `${LEVEL_NAME[level]} ${n}`,
      data.description ?? "",
      data.problem ?? "",
      data.acceptance ?? "",
      data.kind === "test" ? "test" : "impl",
      status,
      repo?.id ?? null,
    );
    if (parent) run("UPDATE items SET next_child = next_child + 1 WHERE id = ?", parent.id);
    else run("UPDATE tasks SET next_number = next_number + 1, updated_at = datetime('now') WHERE id = ?", taskId);
    const item = getItem(Number(r.lastInsertRowid));
    if (data.depends_on?.length) setDeps(taskId, item, data.depends_on);
    return getItem(item.id);
  });
}

export function updateItem(id: number, data: ItemInput): Item {
  return tx(() => {
    const it = getItem(id);
    if (data.repo !== undefined && data.repo !== null && String(data.repo) !== "" && it.level === LEVEL.STEP) {
      const repo = attachRepo(it.task_id, data.repo);
      if (repo.id !== it.repo_id) {
        if (it.branch) throw new VkError("Nie można zmienić repozytorium Kroku, który ma już gałąź");
        run("UPDATE items SET repo_id = ? WHERE id = ?", repo.id, id);
      }
    }
    run(
      `UPDATE items SET title = ?, description = ?, problem = ?, acceptance = ?, kind = ?, updated_at = datetime('now') WHERE id = ?`,
      data.title ?? it.title,
      data.description ?? it.description,
      data.problem ?? it.problem,
      data.acceptance ?? it.acceptance,
      data.kind ?? it.kind,
      id,
    );
    if (data.depends_on) setDeps(it.task_id, getItem(id), data.depends_on);
    if (data.position !== undefined) moveItem(id, data.position);
    return getItem(id);
  });
}

function moveItem(id: number, position: number) {
  const it = getItem(id);
  const siblings = childrenOf(listItems(it.task_id), it.parent_id).filter((x) => x.id !== id);
  const idx = Math.max(0, Math.min(siblings.length, position - 1));
  siblings.splice(idx, 0, it);
  siblings.forEach((x, i) => run("UPDATE items SET position = ? WHERE id = ?", i + 1, x.id));
}

/** Zmienia kolejność rodzeństwa (elementy muszą mieć wspólnego rodzica). */
export function reorderItems(taskId: number, refs: (string | number)[]) {
  tx(() => {
    const listed = refs.map((r) => resolveItemRef(taskId, r));
    if (listed.length === 0) return;
    const parent = listed[0].parent_id;
    if (listed.some((l) => l.parent_id !== parent)) throw new VkError("Można zmieniać kolejność tylko elementów o wspólnym rodzicu");
    const rest = childrenOf(listItems(taskId), parent).filter((s) => !listed.some((l) => l.id === s.id));
    [...listed, ...rest].forEach((s, i) => run("UPDATE items SET position = ? WHERE id = ?", i + 1, s.id));
  });
}

export function setItemFields(id: number, fields: Partial<Omit<ItemRow, "id" | "task_id" | "key" | "level" | "parent_id" | "repo_id">>) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getItem(id);
  run(
    `UPDATE items SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
    ...keys.map((k) => (fields as Record<string, string | number | null>)[k]),
    id,
  );
  return getItem(id);
}

export function deleteItem(id: number) {
  run("DELETE FROM items WHERE id = ?", id);
}

/** Akceptacja planu: wszystkie elementy w Draft -> Todo. */
export function acceptPlan(taskId: number, rootRef?: string) {
  tx(() => {
    const items = listItems(taskId);
    const scope = rootRef ? (() => {
      const root = resolveItemRef(taskId, rootRef);
      const sub = (i: Item): Item[] => [i, ...childrenOf(items, i.id).flatMap(sub)];
      return [...ancestors(items, root), ...sub(root)];
    })() : items;
    for (const i of scope) if (i.status === "draft") run("UPDATE items SET status = 'todo', updated_at = datetime('now') WHERE id = ?", i.id);
    run("UPDATE tasks SET status = 'ready', updated_at = datetime('now') WHERE id = ?", taskId);
  });
}

/**
 * Powody, dla których element (lub jego przodkowie) jest zablokowany:
 * ręcznie wpisany bloker albo otwarte pytanie blokujące.
 */
export function blockReasons(items: Item[], item: Item, questions: Question[]): string[] {
  const out: string[] = [];
  for (const el of [item, ...ancestors(items, item)]) {
    if (el.blocker.trim()) out.push(`${el.key}: ${el.blocker.trim()}`);
    for (const q of questions) if (q.item_id === el.id && q.blocking && q.status === "open") out.push(`${el.key}: pytanie #${q.id} — ${q.question}`);
  }
  for (const q of questions) if (q.item_id === null && q.blocking && q.status === "open") out.push(`ticket: pytanie #${q.id} — ${q.question}`);
  return out;
}

/** Stan uwagi elementu (tylko jego własny): bloker > otwarte pytania > brak. */
export function attention(item: Item, questions: Question[]): "blocker" | "question" | null {
  const own = questions.filter((q) => q.item_id === item.id && q.status === "open");
  if (item.blocker.trim() || own.some((q) => q.blocking)) return "blocker";
  if (own.length) return "question";
  return null;
}

/** Kroki gotowe do realizacji: Todo, przodkowie zaakceptowani, brak blokerów, efektywne zależności w Review/Done. */
export function runnableSteps(taskId: number): Item[] {
  const items = listItems(taskId);
  const questions = listQuestions(taskId);
  return items.filter(
    (s) =>
      s.level === LEVEL.STEP &&
      s.status === "todo" &&
      ancestors(items, s).every((a) => a.status !== "draft") &&
      blockReasons(items, s, questions).length === 0 &&
      effectiveDeps(items, s).every((d) => d.status === "review" || d.status === "done"),
  );
}

// ---------- pytania ----------

type QuestionRow = Omit<Question, "options" | "blocking" | "item_key"> & { options: string; blocking: number; item_key: string | null };

function toQuestion(r: QuestionRow): Question {
  let options: string[] = [];
  try {
    options = JSON.parse(r.options);
  } catch {
    options = [];
  }
  return { ...r, options, blocking: !!r.blocking };
}

const Q_SELECT = "SELECT q.*, i.key AS item_key FROM questions q LEFT JOIN items i ON i.id = q.item_id";

export function listQuestions(taskId: number, opts: { itemId?: number | null; status?: Question["status"] } = {}): Question[] {
  const conds = ["q.task_id = ?"];
  const params: (string | number)[] = [taskId];
  if (opts.itemId !== undefined) {
    if (opts.itemId === null) conds.push("q.item_id IS NULL");
    else {
      conds.push("q.item_id = ?");
      params.push(opts.itemId);
    }
  }
  if (opts.status) {
    conds.push("q.status = ?");
    params.push(opts.status);
  }
  return all<QuestionRow>(`${Q_SELECT} WHERE ${conds.join(" AND ")} ORDER BY q.status = 'open' DESC, q.id`, ...params).map(toQuestion);
}

export function getQuestion(id: number): Question {
  const r = get<QuestionRow>(`${Q_SELECT} WHERE q.id = ?`, id);
  if (!r) throw new VkError(`Brak pytania #${id}`, 404);
  return toQuestion(r);
}

export function createQuestion(taskId: number, data: { item_id?: number | null; question: string; options?: string[]; blocking?: boolean }): Question {
  if (!data.question?.trim()) throw new VkError("Puste pytanie");
  const options = (data.options ?? []).map((o) => String(o).trim()).filter(Boolean);
  const r = run(
    "INSERT INTO questions(task_id, item_id, question, options, blocking) VALUES(?, ?, ?, ?, ?)",
    taskId,
    data.item_id ?? null,
    data.question.trim(),
    JSON.stringify(options),
    data.blocking ? 1 : 0,
  );
  return getQuestion(Number(r.lastInsertRowid));
}

/** Odpowiedź człowieka: wybrana propozycja i/lub własny tekst (np. "omówmy na czacie", "mam pytania"). */
export function answerQuestion(id: number, data: { choice?: string | null; text?: string }): Question {
  const q = getQuestion(id);
  const choice = data.choice && q.options.includes(data.choice) ? data.choice : null;
  const text = (data.text ?? "").trim();
  if (!choice && !text) throw new VkError("Wybierz odpowiedź albo wpisz własną");
  run("UPDATE questions SET status = 'answered', answer_choice = ?, answer_text = ?, answered_at = datetime('now') WHERE id = ?", choice, text, id);
  return getQuestion(id);
}

export function reopenQuestion(id: number): Question {
  run("UPDATE questions SET status = 'open', answer_choice = NULL, answer_text = '', answered_at = NULL WHERE id = ?", id);
  return getQuestion(id);
}

export function closeQuestion(id: number, note = ""): Question {
  run("UPDATE questions SET status = 'closed', note = ? WHERE id = ?", note, id);
  return getQuestion(id);
}

export function deleteQuestion(id: number) {
  run("DELETE FROM questions WHERE id = ?", id);
}

// ---------- resources ----------

export function listResources(scope: Resource["scope"], scopeId: number | null): Resource[] {
  return scope === "global"
    ? all<Resource>("SELECT * FROM resources WHERE scope = 'global' ORDER BY name")
    : all<Resource>("SELECT * FROM resources WHERE scope = ? AND scope_id = ? ORDER BY name", scope, scopeId);
}

/** Zasoby dostępne dla zadania (globalne + zadania). */
export function effectiveResources(task: Task): Resource[] {
  return [...listResources("global", null), ...listResources("task", task.id)];
}

export function createResource(data: Omit<Resource, "id" | "note"> & { note?: string }): Resource {
  const kind = data.kind === "git" || /^(https?:\/\/|git@|ssh:\/\/)/.test(data.location) ? "git" : "path";
  const scope = data.scope === "task" ? "task" : "global";
  const r = run(
    "INSERT INTO resources(scope, scope_id, name, kind, location, note) VALUES(?, ?, ?, ?, ?, ?)",
    scope,
    scope === "global" ? null : data.scope_id,
    data.name || data.location,
    kind,
    data.location.trim(),
    data.note ?? "",
  );
  return get<Resource>("SELECT * FROM resources WHERE id = ?", Number(r.lastInsertRowid))!;
}

export function deleteResource(id: number) {
  run("DELETE FROM resources WHERE id = ?", id);
}

// ---------- comments ----------

export function listComments(itemId: number, includeResolved = true): Comment[] {
  return all<Comment>(`SELECT * FROM comments WHERE item_id = ? ${includeResolved ? "" : "AND resolved = 0"} ORDER BY file, line, id`, itemId);
}

export function createComment(itemId: number, data: { file?: string; line?: number; side?: string; line_text?: string; body: string }) {
  getItem(itemId);
  if (!data.body?.trim()) throw new VkError("Pusty komentarz");
  const r = run(
    "INSERT INTO comments(item_id, file, line, side, line_text, body) VALUES(?, ?, ?, ?, ?, ?)",
    itemId,
    data.file ?? null,
    data.line ?? null,
    data.side ?? null,
    data.line_text ?? null,
    data.body.trim(),
  );
  return get<Comment>("SELECT * FROM comments WHERE id = ?", Number(r.lastInsertRowid))!;
}

export function updateComment(id: number, data: { body?: string; resolved?: boolean; resolution?: string }) {
  const c = get<Comment>("SELECT * FROM comments WHERE id = ?", id);
  if (!c) throw new VkError(`Brak komentarza ${id}`, 404);
  run(
    "UPDATE comments SET body = ?, resolved = ?, resolution = ? WHERE id = ?",
    data.body ?? c.body,
    data.resolved === undefined ? c.resolved : data.resolved ? 1 : 0,
    data.resolution ?? c.resolution,
    id,
  );
  return get<Comment>("SELECT * FROM comments WHERE id = ?", id)!;
}

export function deleteComment(id: number) {
  run("DELETE FROM comments WHERE id = ?", id);
}
