import fs from "node:fs";
import path from "node:path";
import { ensureGitResource, taskBranch, taskWorktreePath } from "./git.js";
import { slug, subdir } from "./paths.js";
import {
  effectiveResources,
  getProject,
  getSettings,
  listRepos,
  listComments,
  listSubtasks,
  type Comment,
  type Subtask,
  type Task,
} from "./repo.js";

export interface ResolvedResource {
  name: string;
  scope: string;
  kind: string;
  location: string;
  local_path: string | null;
  note: string;
}

/** Zasoby zadania z rozwiązanymi ścieżkami lokalnymi. clone=true klonuje brakujące repozytoria git. */
export function resolveResources(task: Task, clone: boolean): ResolvedResource[] {
  return effectiveResources(task).map((r) => {
    let local: string | null = null;
    if (r.kind === "git") {
      const cached = path.join(subdir("cache"), slug(r.location.replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")));
      if (clone) {
        try {
          local = ensureGitResource(r.location);
        } catch (e) {
          process.stderr.write(`[vk] Nie udało się sklonować ${r.location}: ${(e as Error).message}\n`);
        }
      } else if (fs.existsSync(cached)) local = cached;
    } else {
      local = path.resolve(r.location.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
      if (!fs.existsSync(local)) local = null;
    }
    return { name: r.name, scope: r.scope, kind: r.kind, location: r.location, local_path: local, note: r.note };
  });
}

export function taskContext(task: Task) {
  const project = getProject(task.project_id);
  const subs = listSubtasks(task.id);
  return {
    key: task.key,
    title: task.title,
    description: task.description,
    ticket: task.ticket_url ? { id: task.ticket_id, url: task.ticket_url } : null,
    links: task.links,
    assumptions: {
      project: project.assumptions,
      task: task.assumptions,
    },
    project: { name: project.name, description: project.description || undefined },
    repositories: reposContext(task),
    task_branch: taskBranch(task),
    resources_readonly: resolveResources(task, false),
    status: task.status,
    subtasks: subs.map(subtaskSummary),
  };
}

/** Repozytoria projektu: ścieżka, gałąź bazowa, gałąź i worktree zadania w danym repo. */
export function reposContext(task: Task) {
  return listRepos(task.project_id).map((r) => ({
    name: r.name,
    path: r.path,
    base_branch: r.base_branch,
    description: r.description || undefined,
    task_worktree: taskWorktreePath(task, r),
  }));
}

export function subtaskSummary(s: Subtask) {
  return {
    key: s.key,
    repo: s.repo,
    position: s.position,
    title: s.title,
    status: s.status,
    depends_on: s.depends_on,
    description: s.description,
    problem: s.problem,
    acceptance: s.acceptance,
    summary: s.summary || undefined,
  };
}

export function subtaskContext(s: Subtask) {
  return {
    ...subtaskSummary(s),
    branch: s.branch,
    worktree_path: s.worktree_path,
    base_ref: s.base_ref,
    error: s.error || undefined,
    review_comments: listComments(s.id, true).map(commentView),
  };
}

export function commentView(c: Comment) {
  return {
    id: c.id,
    file: c.file,
    line: c.line,
    side: c.side,
    line_text: c.line_text,
    body: c.body,
    resolved: !!c.resolved,
    resolution: c.resolution || undefined,
  };
}

// ---------- prompty ----------

export type PromptKind = "plan" | "impl" | "review";

export function promptTemplate(task: Task, kind: PromptKind): string {
  const own = kind === "plan" ? task.plan_prompt : kind === "impl" ? task.impl_prompt : task.review_prompt;
  return own ?? getSettings()[`${kind}_prompt`];
}

function reposText(task: Task) {
  return (
    listRepos(task.project_id)
      .map((r) => `- ${r.name}: ${r.path} (baza ${r.base_branch})${r.description ? ` — ${r.description}` : ""}`)
      .join("\n") || "(brak)"
  );
}

function linksText(task: Task) {
  return task.links.map((l) => `- ${l.url}${l.note ? ` — ${l.note}` : ""}`).join("\n") || "(brak)";
}

function resourcesText(res: ResolvedResource[]) {
  return (
    res
      .map((r) => `- ${r.name} [${r.scope}] ${r.local_path ?? r.location}${r.local_path ? "" : " (niedostępne lokalnie)"}${r.note ? ` — ${r.note}` : ""}`)
      .join("\n") || "(brak)"
  );
}

function commentsText(comments: Comment[]) {
  return (
    comments
      .filter((c) => !c.resolved)
      .map((c) => `- #${c.id} ${c.file ? `${c.file}${c.line ? `:${c.line}` : ""}` : "(ogólny)"}: ${c.body}`)
      .join("\n") || "(brak otwartych komentarzy)"
  );
}

export function renderPrompt(tpl: string, task: Task, sub?: Subtask, res?: ResolvedResource[]): string {
  const project = getProject(task.project_id);
  const vars: Record<string, string> = {
    "task.key": task.key,
    "task.title": task.title,
    "task.description": task.description || "(brak)",
    "task.ticket_id": task.ticket_id || "(brak)",
    "task.ticket_url": task.ticket_url || "(brak)",
    "task.assumptions": task.assumptions || "(brak)",
    "task.links": linksText(task),
    "project.name": project.name,
    repos: reposText(task),
    "project.assumptions": project.assumptions || "(brak)",
    resources: resourcesText(res ?? resolveResources(task, false)),
  };
  if (sub) {
    Object.assign(vars, {
      "subtask.key": sub.key,
      "subtask.title": sub.title,
      "subtask.description": sub.description || "(brak)",
      "subtask.problem": sub.problem || "(brak)",
      "subtask.acceptance": sub.acceptance || "(brak)",
      "subtask.deps": sub.depends_on.join(", ") || "(brak)",
      comments: commentsText(listComments(sub.id, false)),
    });
  }
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** Tekst dołączany do system promptu każdej sesji (--append-system-prompt). */
export function sessionSystemPrompt(kind: PromptKind, task: Task, res: ResolvedResource[], sub?: Subtask): string {
  const project = getProject(task.project_id);
  const role =
    kind === "plan"
      ? "To jest sesja PLANOWANIA zadania. Analizujesz i rozbijasz zadanie na podzadania na tablicy kanban. Nie implementujesz kodu."
      : kind === "impl"
        ? `To jest sesja IMPLEMENTACJI podzadania ${sub?.key} uruchomiona automatycznie (subagent). Pracujesz w worktree podzadania.`
        : `To jest sesja pracy nad podzadaniem ${sub?.key} (review / poprawki) w jego worktree.`;
  return [
    "# vibe-kanban",
    role,
    "",
    `Zadanie główne: ${task.key} — ${task.title}`,
    task.ticket_url ? `Ticket: ${task.ticket_id} (${task.ticket_url})` : "",
    `Projekt: ${project.name}${project.description ? ` — ${project.description}` : ""}`,
    sub ? `Podzadanie: ${sub.key} — ${sub.title}; repozytorium ${sub.repo}; gałąź ${sub.branch}; baza ${sub.base_ref}` : "",
    "",
    "Masz serwer MCP `vibe-kanban` (narzędzia vk_*) z pełnym kontekstem zadania, podzadań i komentarzy z review.",
    "Zawsze korzystaj z vk_get_task, gdy potrzebujesz opisu, założeń, linków lub zasobów.",
    "",
    "## Repozytoria projektu",
    kind === "plan"
      ? "Zadanie może wymagać zmian w kilku repozytoriach. Każde podzadanie dotyczy JEDNEGO repo (parametr repo w vk_create_subtask). Zależności między repo wyrażaj przez depends_on."
      : `Pracujesz w repozytorium ${sub?.repo}. Pozostałe repozytoria projektu są dostępne TYLKO DO ODCZYTU (np. żeby sprawdzić kontrakt API).`,
    reposText(task),
    "",
    "## Założenia projektu",
    project.assumptions || "(brak)",
    "",
    "## Założenia zadania",
    task.assumptions || "(brak)",
    "",
    "## Linki do wykorzystania",
    linksText(task),
    "",
    "## Zasoby referencyjne — TYLKO DO ODCZYTU",
    "Możesz je czytać i wzorować się na nich. Nigdy ich nie modyfikuj (żadnych edycji, zapisów, komend git zmieniających stan).",
    resourcesText(res),
    "",
    "## Zasady",
    "- Wszystko dzieje się lokalnie: nie wykonuj `git push`, nie twórz pull requestów, nie publikuj niczego.",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/\n(#+ )/g, "\n\n$1");
}

// ---------- uruchamianie claude ----------

export function mcpConfig(cli: string, taskKey: string, subKey?: string): string {
  const args = ["--no-warnings", cli, "mcp", "--task", taskKey];
  if (subKey) args.push("--subtask", subKey);
  const env: Record<string, string> = {};
  if (process.env.VK_HOME) env.VK_HOME = process.env.VK_HOME;
  return JSON.stringify({ mcpServers: { "vibe-kanban": { command: process.execPath, args, env } } });
}

/** Ustawienia z regułami deny dla zasobów tylko do odczytu. */
export function readonlySettings(res: ResolvedResource[]): string {
  const deny: string[] = [];
  for (const r of res) {
    if (!r.local_path) continue;
    const p = `/${r.local_path.replace(/\/+$/, "")}/**`; // "//abs/path/**" = ścieżka absolutna
    deny.push(`Edit(${p})`, `Write(${p})`, `NotebookEdit(${p})`);
  }
  return JSON.stringify({ permissions: { deny } });
}

export function addDirArgs(res: ResolvedResource[]): string[] {
  const dirs = res.map((r) => r.local_path).filter((p): p is string => !!p);
  return dirs.length ? ["--add-dir", ...dirs] : [];
}

export function commentsForTask(task: Task) {
  return listSubtasks(task.id).flatMap((s) => listComments(s.id, false).map((c) => ({ subtask: s.key, ...commentView(c) })));
}
