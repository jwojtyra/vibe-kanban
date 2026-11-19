import { randomUUID } from "node:crypto";
import { all, get, run, tx } from "./db.js";
import { DEFAULT_SETTINGS } from "./defaults.js";

export type SubtaskStatus = "draft" | "todo" | "in_progress" | "review" | "done" | "blocked";
export const SUBTASK_STATUSES: SubtaskStatus[] = ["draft", "todo", "in_progress", "review", "done", "blocked"];

export interface Project {
  id: number;
  name: string;
  description: string;
  assumptions: string;
  created_at: string;
}

/** Repozytorium należące do projektu (np. frontend, backend). */
export interface Repo {
  id: number;
  project_id: number;
  name: string;
  path: string;
  base_branch: string;
  description: string;
  created_at: string;
}

export interface Link {
  url: string;
  note?: string;
}

export interface Task {
  id: number;
  project_id: number;
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

export interface Subtask {
  id: number;
  task_id: number;
  key: string;
  number: number;
  position: number;
  title: string;
  description: string;
  problem: string;
  acceptance: string;
  status: SubtaskStatus;
  repo_id: number | null;
  repo: string | null; // nazwa repozytorium
  branch: string | null;
  worktree_path: string | null;
  base_ref: string | null;
  agent_session_id: string | null;
  review_session_id: string | null;
  summary: string;
  error: string;
  log_path: string | null;
  created_at: string;
  updated_at: string;
  depends_on: string[]; // klucze podzadań
}

export interface Resource {
  id: number;
  scope: "global" | "project" | "task";
  scope_id: number | null;
  name: string;
  kind: "path" | "git";
  location: string;
  note: string;
}

export interface Comment {
  id: number;
  subtask_id: number;
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
  constructor(message: string, public status = 400) {
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

export function getSetting(key: string): string {
  return getSettings()[key] ?? "";
}

export function updateSettings(values: Record<string, string>) {
  tx(() => {
    for (const [k, v] of Object.entries(values)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, String(v));
    }
  });
}

// ---------- projects ----------

export function listProjects(): Project[] {
  return all<Project>("SELECT * FROM projects ORDER BY name");
}

export function getProject(id: number): Project {
  const p = get<Project>("SELECT * FROM projects WHERE id = ?", id);
  if (!p) throw new VkError(`Brak projektu ${id}`, 404);
  return p;
}

/** Projekt po ID albo nazwie. */
export function findProject(ref: string | number): Project {
  const p =
    (typeof ref === "number" || /^\d+$/.test(String(ref)) ? get<Project>("SELECT * FROM projects WHERE id = ?", Number(ref)) : undefined) ??
    get<Project>("SELECT * FROM projects WHERE name = ?", String(ref));
  if (!p) throw new VkError(`Brak projektu "${ref}"`, 404);
  return p;
}

export function createProject(data: { name: string; description?: string; assumptions?: string }): Project {
  const name = data.name?.trim();
  if (!name) throw new VkError("Podaj nazwę projektu");
  if (get("SELECT 1 FROM projects WHERE name = ?", name)) throw new VkError(`Projekt "${name}" już istnieje`);
  const r = run("INSERT INTO projects(name, description, assumptions) VALUES(?, ?, ?)", name, data.description ?? "", data.assumptions ?? "");
  return getProject(Number(r.lastInsertRowid));
}

export function updateProject(id: number, data: Partial<Pick<Project, "name" | "description" | "assumptions">>) {
  const p = getProject(id);
  run(
    "UPDATE projects SET name = ?, description = ?, assumptions = ? WHERE id = ?",
    data.name?.trim() || p.name,
    data.description ?? p.description,
    data.assumptions ?? p.assumptions,
    id,
  );
  return getProject(id);
}

export function deleteProject(id: number) {
  run("DELETE FROM resources WHERE scope = 'project' AND scope_id = ?", id);
  run("DELETE FROM projects WHERE id = ?", id);
}

// ---------- repos ----------

export function listRepos(projectId: number): Repo[] {
  return all<Repo>("SELECT * FROM repos WHERE project_id = ? ORDER BY id", projectId);
}

export function getRepo(id: number): Repo {
  const r = get<Repo>("SELECT * FROM repos WHERE id = ?", id);
  if (!r) throw new VkError(`Brak repozytorium ${id}`, 404);
  return r;
}

/** Repozytorium projektu po nazwie lub ID. */
export function findRepo(projectId: number, ref: string | number): Repo {
  const s = String(ref).trim();
  const r =
    get<Repo>("SELECT * FROM repos WHERE project_id = ? AND name = ?", projectId, s) ??
    (/^\d+$/.test(s) ? get<Repo>("SELECT * FROM repos WHERE project_id = ? AND id = ?", projectId, Number(s)) : undefined);
  if (!r) {
    const names = listRepos(projectId).map((x) => x.name).join(", ") || "(brak)";
    throw new VkError(`Brak repozytorium "${s}" w projekcie. Dostępne: ${names}`, 404);
  }
  return r;
}

export function createRepo(data: { project_id: number; name?: string; path: string; base_branch: string; description?: string }): Repo {
  getProject(data.project_id);
  const name = (data.name?.trim() || data.path.split("/").filter(Boolean).pop() || "repo").replace(/\s+/g, "-");
  if (get("SELECT 1 FROM repos WHERE project_id = ? AND name = ?", data.project_id, name)) {
    throw new VkError(`Repozytorium o nazwie "${name}" już jest w projekcie`);
  }
  if (get("SELECT 1 FROM repos WHERE project_id = ? AND path = ?", data.project_id, data.path)) {
    throw new VkError(`Repozytorium ${data.path} już jest w projekcie`);
  }
  const r = run(
    "INSERT INTO repos(project_id, name, path, base_branch, description) VALUES(?, ?, ?, ?, ?)",
    data.project_id,
    name,
    data.path,
    data.base_branch,
    data.description ?? "",
  );
  return getRepo(Number(r.lastInsertRowid));
}

export function updateRepo(id: number, data: Partial<Pick<Repo, "name" | "base_branch" | "description">>) {
  const r = getRepo(id);
  run(
    "UPDATE repos SET name = ?, base_branch = ?, description = ? WHERE id = ?",
    data.name?.trim() || r.name,
    data.base_branch?.trim() || r.base_branch,
    data.description ?? r.description,
    id,
  );
  return getRepo(id);
}

export function deleteRepo(id: number) {
  const used = get<{ c: number }>("SELECT COUNT(*) AS c FROM subtasks WHERE repo_id = ? AND status NOT IN ('done', 'draft', 'todo')", id);
  if (used && used.c > 0) throw new VkError("Repozytorium ma podzadania w trakcie lub w review — najpierw je zakończ");
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

export function listTasks(projectId: number): Task[] {
  return all<TaskRow>("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC", projectId).map(toTask);
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
  project_id: number;
  title: string;
  description?: string;
  ticket_url?: string;
  assumptions?: string;
  links?: Link[];
}): Task {
  getProject(data.project_id);
  const ticketId = extractTicketId(data.ticket_url ?? "");
  let baseKey = ticketId;
  if (!baseKey) {
    const n = (get<{ c: number }>("SELECT COUNT(*) AS c FROM tasks")?.c ?? 0) + 1;
    baseKey = `VK-${n}`;
  }
  const key = uniqueTaskKey(baseKey);
  const title = data.title?.trim() || ticketId || "Nowe zadanie";
  const r = run(
    `INSERT INTO tasks(project_id, key, title, description, ticket_url, ticket_id, assumptions, links, plan_session_id)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    data.project_id,
    key,
    title,
    data.description ?? "",
    data.ticket_url ?? "",
    ticketId,
    data.assumptions ?? "",
    JSON.stringify(data.links ?? []),
    randomUUID(),
  );
  return getTask(Number(r.lastInsertRowid));
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

// ---------- subtasks ----------

type SubtaskRow = Omit<Subtask, "depends_on" | "repo">;

function withDeps(rows: SubtaskRow[]): Subtask[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const deps = all<{ subtask_id: number; key: string }>(
    `SELECT d.subtask_id, s.key FROM subtask_deps d JOIN subtasks s ON s.id = d.depends_on_id
     WHERE d.subtask_id IN (${ids.map(() => "?").join(",")}) ORDER BY s.position`,
    ...ids,
  );
  const repoNames = new Map(all<{ id: number; name: string }>("SELECT id, name FROM repos").map((r) => [r.id, r.name]));
  return rows.map((r) => ({
    ...r,
    repo: r.repo_id != null ? (repoNames.get(r.repo_id) ?? null) : null,
    depends_on: deps.filter((d) => d.subtask_id === r.id).map((d) => d.key),
  }));
}

export function listSubtasks(taskId: number): Subtask[] {
  return withDeps(all<SubtaskRow>("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position, number", taskId));
}

export function getSubtask(id: number): Subtask {
  const r = get<SubtaskRow>("SELECT * FROM subtasks WHERE id = ?", id);
  if (!r) throw new VkError(`Brak podzadania ${id}`, 404);
  return withDeps([r])[0];
}

export function getSubtaskByKey(key: string): Subtask {
  const r = get<SubtaskRow>("SELECT * FROM subtasks WHERE key = ?", key);
  if (!r) throw new VkError(`Brak podzadania o kluczu ${key}`, 404);
  return withDeps([r])[0];
}

/** Rozwiązuje odwołanie do podzadania w obrębie zadania: klucz ("PROJ-1-2") albo numer ("2"). */
export function resolveSubtaskRef(taskId: number, ref: string | number): Subtask {
  const s = String(ref).trim();
  const row =
    get<SubtaskRow>("SELECT * FROM subtasks WHERE task_id = ? AND key = ?", taskId, s) ??
    (/^\d+$/.test(s) ? get<SubtaskRow>("SELECT * FROM subtasks WHERE task_id = ? AND number = ?", taskId, Number(s)) : undefined);
  if (!row) throw new VkError(`Brak podzadania "${s}" w tym zadaniu`, 404);
  return withDeps([row])[0];
}

export interface SubtaskInput {
  repo?: string | number | null; // nazwa lub ID repozytorium projektu
  title?: string;
  description?: string;
  problem?: string;
  acceptance?: string;
  position?: number;
  depends_on?: (string | number)[];
}

function setDeps(taskId: number, subtaskId: number, refs: (string | number)[]) {
  const depIds = refs.map((r) => resolveSubtaskRef(taskId, r).id);
  if (depIds.includes(subtaskId)) throw new VkError("Podzadanie nie może zależeć od samego siebie");
  // wykrywanie cykli
  const graph = new Map<number, number[]>();
  for (const d of all<{ subtask_id: number; depends_on_id: number }>(
    "SELECT d.* FROM subtask_deps d JOIN subtasks s ON s.id = d.subtask_id WHERE s.task_id = ?",
    taskId,
  )) {
    if (d.subtask_id === subtaskId) continue;
    graph.set(d.subtask_id, [...(graph.get(d.subtask_id) ?? []), d.depends_on_id]);
  }
  graph.set(subtaskId, depIds);
  const visiting = new Set<number>();
  const visit = (n: number): void => {
    if (visiting.has(n)) throw new VkError("Zależności tworzą cykl");
    visiting.add(n);
    for (const m of graph.get(n) ?? []) visit(m);
    visiting.delete(n);
  };
  visit(subtaskId);
  run("DELETE FROM subtask_deps WHERE subtask_id = ?", subtaskId);
  for (const d of new Set(depIds)) run("INSERT INTO subtask_deps(subtask_id, depends_on_id) VALUES(?, ?)", subtaskId, d);
}

/** Repozytorium dla podzadania: wskazane albo jedyne w projekcie. */
function pickRepo(projectId: number, ref: SubtaskInput["repo"]): Repo {
  if (ref !== undefined && ref !== null && String(ref).trim() !== "") return findRepo(projectId, ref);
  const repos = listRepos(projectId);
  if (repos.length === 1) return repos[0];
  if (repos.length === 0) throw new VkError("Projekt nie ma repozytoriów — dodaj repozytorium (UI, API lub vk_add_repo)");
  throw new VkError(`Projekt ma kilka repozytoriów — wskaż repo: ${repos.map((r) => r.name).join(", ")}`);
}

export function createSubtask(taskId: number, data: SubtaskInput, status: SubtaskStatus = "draft"): Subtask {
  return tx(() => {
    const t = getTask(taskId);
    const repo = pickRepo(t.project_id, data.repo);
    const number = t.next_number;
    const maxPos = get<{ m: number | null }>("SELECT MAX(position) AS m FROM subtasks WHERE task_id = ?", taskId)?.m ?? 0;
    const position = data.position ?? maxPos + 1;
    if (data.position !== undefined) {
      run("UPDATE subtasks SET position = position + 1 WHERE task_id = ? AND position >= ?", taskId, position);
    }
    const r = run(
      `INSERT INTO subtasks(task_id, key, number, position, title, description, problem, acceptance, status, repo_id)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      taskId,
      `${t.key}-${number}`,
      number,
      position,
      data.title?.trim() || `Podzadanie ${number}`,
      data.description ?? "",
      data.problem ?? "",
      data.acceptance ?? "",
      status,
      repo.id,
    );
    run("UPDATE tasks SET next_number = next_number + 1, updated_at = datetime('now') WHERE id = ?", taskId);
    const id = Number(r.lastInsertRowid);
    if (data.depends_on?.length) setDeps(taskId, id, data.depends_on);
    return getSubtask(id);
  });
}

export function updateSubtask(id: number, data: SubtaskInput): Subtask {
  return tx(() => {
    const s = getSubtask(id);
    if (data.repo !== undefined && data.repo !== null && String(data.repo) !== "") {
      const repo = findRepo(getTask(s.task_id).project_id, data.repo);
      if (repo.id !== s.repo_id) {
        if (s.branch) throw new VkError("Nie można zmienić repozytorium podzadania, które ma już gałąź");
        run("UPDATE subtasks SET repo_id = ? WHERE id = ?", repo.id, id);
      }
    }
    run(
      `UPDATE subtasks SET title = ?, description = ?, problem = ?, acceptance = ?, updated_at = datetime('now') WHERE id = ?`,
      data.title ?? s.title,
      data.description ?? s.description,
      data.problem ?? s.problem,
      data.acceptance ?? s.acceptance,
      id,
    );
    if (data.depends_on) setDeps(s.task_id, id, data.depends_on);
    if (data.position !== undefined) moveSubtask(id, data.position);
    return getSubtask(id);
  });
}

function moveSubtask(id: number, position: number) {
  const s = getSubtask(id);
  const ordered = listSubtasks(s.task_id).filter((x) => x.id !== id);
  const idx = Math.max(0, Math.min(ordered.length, position - 1));
  ordered.splice(idx, 0, s);
  ordered.forEach((x, i) => run("UPDATE subtasks SET position = ? WHERE id = ?", i + 1, x.id));
}

export function reorderSubtasks(taskId: number, refs: (string | number)[]) {
  tx(() => {
    const listed = refs.map((r) => resolveSubtaskRef(taskId, r));
    const rest = listSubtasks(taskId).filter((s) => !listed.some((l) => l.id === s.id));
    [...listed, ...rest].forEach((s, i) => run("UPDATE subtasks SET position = ? WHERE id = ?", i + 1, s.id));
  });
}

export function setSubtaskFields(id: number, fields: Partial<Omit<SubtaskRow, "id" | "task_id" | "key" | "number" | "repo_id">>) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getSubtask(id);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  run(
    `UPDATE subtasks SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
    ...keys.map((k) => (fields as Record<string, string | number | null>)[k]),
    id,
  );
  return getSubtask(id);
}

export function deleteSubtask(id: number) {
  run("DELETE FROM subtasks WHERE id = ?", id);
}

/** Akceptacja planu: wszystkie podzadania draft -> todo. */
export function acceptPlan(taskId: number) {
  tx(() => {
    run("UPDATE subtasks SET status = 'todo', updated_at = datetime('now') WHERE task_id = ? AND status = 'draft'", taskId);
    run("UPDATE tasks SET status = 'ready', updated_at = datetime('now') WHERE id = ?", taskId);
  });
}

/** Podzadania gotowe do uruchomienia: todo, a wszystkie zależności w review lub done. */
export function runnableSubtasks(taskId: number): Subtask[] {
  const subs = listSubtasks(taskId);
  const byKey = new Map(subs.map((s) => [s.key, s]));
  return subs.filter(
    (s) => s.status === "todo" && s.depends_on.every((k) => ["review", "done"].includes(byKey.get(k)?.status ?? "")),
  );
}

// ---------- resources ----------

export function listResources(scope: Resource["scope"], scopeId: number | null): Resource[] {
  return scope === "global"
    ? all<Resource>("SELECT * FROM resources WHERE scope = 'global' ORDER BY name")
    : all<Resource>("SELECT * FROM resources WHERE scope = ? AND scope_id = ? ORDER BY name", scope, scopeId);
}

/** Wszystkie zasoby dostępne dla zadania (globalne + projektu + zadania). */
export function effectiveResources(task: Task): Resource[] {
  return [...listResources("global", null), ...listResources("project", task.project_id), ...listResources("task", task.id)];
}

export function createResource(data: Omit<Resource, "id" | "note"> & { note?: string }): Resource {
  const kind = data.kind === "git" || /^(https?:\/\/|git@|ssh:\/\/)/.test(data.location) ? "git" : "path";
  const r = run(
    "INSERT INTO resources(scope, scope_id, name, kind, location, note) VALUES(?, ?, ?, ?, ?, ?)",
    data.scope,
    data.scope === "global" ? null : data.scope_id,
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

export function listComments(subtaskId: number, includeResolved = true): Comment[] {
  return all<Comment>(
    `SELECT * FROM comments WHERE subtask_id = ? ${includeResolved ? "" : "AND resolved = 0"} ORDER BY file, line, id`,
    subtaskId,
  );
}

export function createComment(subtaskId: number, data: { file?: string; line?: number; side?: string; line_text?: string; body: string }) {
  getSubtask(subtaskId);
  if (!data.body?.trim()) throw new VkError("Pusty komentarz");
  const r = run(
    "INSERT INTO comments(subtask_id, file, line, side, line_text, body) VALUES(?, ?, ?, ?, ?, ?)",
    subtaskId,
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
